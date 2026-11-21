#import <Foundation/Foundation.h>
#include <signal.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

// MusicHelper runs AppleScript in its own app bundle so macOS attributes the
// Music automation permission to this helper instead of the Harness host.
//
// Two modes:
//   * no arguments — long-lived daemon on /tmp/dsh-music/helper.sock, one JSON
//     request per connection: {"source": "<AppleScript>"} or {"ping": true} or
//     {"shutdown": true}; replies {"ok": true, "result": "..."} and closes.
//   * <script-file> <result-file> — one-shot run, kept for debugging.

static NSString *const kDirectory = @"/tmp/dsh-music";
static const NSTimeInterval kIdleTimeout = 300;

static NSDictionary *RunSource(NSString *source) {
  NSMutableDictionary *out = [NSMutableDictionary dictionary];
  NSDictionary *errorInfo = nil;
  NSAppleScript *script = [[NSAppleScript alloc] initWithSource:source ?: @""];
  NSAppleEventDescriptor *result = [script executeAndReturnError:&errorInfo];
  if (errorInfo) {
    out[@"ok"] = @NO;
    out[@"error"] = errorInfo[NSAppleScriptErrorMessage] ?: @"AppleScript failed";
    out[@"code"] = errorInfo[NSAppleScriptErrorNumber] ?: @0;
  } else {
    out[@"ok"] = @YES;
    out[@"result"] = result.stringValue ?: @"";
  }
  return out;
}

static BOOL ReadExact(int fd, void *buffer, size_t length) {
  uint8_t *cursor = buffer;
  size_t received = 0;
  while (received < length) {
    ssize_t count = read(fd, cursor + received, length - received);
    if (count <= 0) {
      return NO;
    }
    received += (size_t)count;
  }
  return YES;
}

static void WriteJSON(int fd, NSDictionary *payload) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
  const uint8_t *bytes = data.bytes;
  NSUInteger remaining = data.length;
  while (remaining > 0) {
    ssize_t written = write(fd, bytes, remaining);
    if (written <= 0) {
      break;
    }
    bytes += written;
    remaining -= (NSUInteger)written;
  }
}

static NSString *LockPath(void) {
  return [kDirectory stringByAppendingPathComponent:@"helper.lock"];
}

static BOOL SocketIsServed(NSString *path) {
  int probe = socket(AF_UNIX, SOCK_STREAM, 0);
  if (probe < 0) {
    return NO;
  }
  struct sockaddr_un addr;
  memset(&addr, 0, sizeof(addr));
  addr.sun_family = AF_UNIX;
  strlcpy(addr.sun_path, path.fileSystemRepresentation, sizeof(addr.sun_path));
  BOOL served = connect(probe, (struct sockaddr *)&addr, sizeof(addr)) == 0;
  close(probe);
  return served;
}

static NSString *SocketPath(void) {
  return [kDirectory stringByAppendingPathComponent:@"helper.sock"];
}

static void UnlinkSocket(void) {
  unlink(SocketPath().fileSystemRepresentation);
}

int main(int argc, char **argv) {
  @autoreleasepool {
    [[NSFileManager defaultManager] createDirectoryAtPath:kDirectory
                              withIntermediateDirectories:YES
                                               attributes:nil
                                                    error:nil];

    if (argc >= 3) {
      NSString *scriptPath = [NSString stringWithUTF8String:argv[1]];
      NSString *outPath = [NSString stringWithUTF8String:argv[2]];
      NSError *readError = nil;
      NSString *source = [NSString stringWithContentsOfFile:scriptPath
                                                   encoding:NSUTF8StringEncoding
                                                      error:&readError];
      NSDictionary *result = source.length
        ? RunSource(source)
        : @{@"ok": @NO, @"error": readError.localizedDescription ?: @"cannot read script"};
      NSData *data = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
      [data writeToFile:outPath atomically:YES];
      return 0;
    }

    signal(SIGTERM, SIG_DFL);
    signal(SIGINT, SIG_DFL);
    atexit(UnlinkSocket);

    NSString *sockPath = SocketPath();
    NSString *lockPath = LockPath();
    int lockFD = open(lockPath.fileSystemRepresentation, O_CREAT | O_RDWR, 0600);
    if (lockFD < 0 || flock(lockFD, LOCK_EX | LOCK_NB) != 0) {
      // Another daemon owns the lock; this launch is redundant.
      return 0;
    }
    if (SocketIsServed(sockPath)) {
      // A live daemon already answers on this socket; never rebind it.
      return 0;
    }
    UnlinkSocket();

    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) {
      return 2;
    }
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strlcpy(addr.sun_path, sockPath.fileSystemRepresentation, sizeof(addr.sun_path));
    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
      close(fd);
      return 3;
    }
    chmod(sockPath.fileSystemRepresentation, 0600);
    if (listen(fd, 16) != 0) {
      close(fd);
      return 4;
    }

    __block NSTimeInterval lastActivity = [NSDate timeIntervalSinceReferenceDate];
    dispatch_queue_t queue = dispatch_queue_create("dsh.music.helper", NULL);

    dispatch_source_t server = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, (uintptr_t)fd, 0, queue);
    dispatch_source_set_event_handler(server, ^{
      int client = accept(fd, NULL, NULL);
      if (client < 0) {
        return;
      }
      lastActivity = [NSDate timeIntervalSinceReferenceDate];
      struct timeval receiveTimeout = {30, 0};
      setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &receiveTimeout, sizeof(receiveTimeout));

      uint32_t length = 0;
      if (!ReadExact(client, &length, sizeof(length))) {
        close(client);
        return;
      }
      length = ntohl(length);
      if (length == 0 || length > (1u << 20)) {
        close(client);
        return;
      }
      NSMutableData *buffer = [NSMutableData dataWithLength:length];
      if (!ReadExact(client, buffer.mutableBytes, length)) {
        close(client);
        return;
      }

      NSDictionary *request = [NSJSONSerialization JSONObjectWithData:buffer options:0 error:nil];
      NSDictionary *response;
      BOOL shutdown = NO;
      if ([request[@"shutdown"] boolValue]) {
        shutdown = YES;
        response = @{@"ok": @YES, @"result": @"bye"};
      } else if ([request[@"ping"] boolValue]) {
        response = @{@"ok": @YES, @"result": @"pong"};
      } else if ([request[@"source"] isKindOfClass:[NSString class]]) {
        __block NSDictionary *scriptResponse = nil;
        dispatch_semaphore_t finished = dispatch_semaphore_create(0);
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
          scriptResponse = RunSource(request[@"source"]);
          dispatch_semaphore_signal(finished);
        });
        if (dispatch_semaphore_wait(finished, dispatch_time(DISPATCH_TIME_NOW, 8 * NSEC_PER_SEC)) != 0) {
          // The Music app stopped answering; exit so the next call starts clean.
          fprintf(stderr, "dsh-music: AppleScript watchdog expired\n");
          exit(9);
        }
        response = scriptResponse;
      } else {
        response = @{@"ok": @NO, @"error": @"missing source"};
      }
      WriteJSON(client, response);
      close(client);
      if (shutdown) {
        exit(0);
      }
    });
    dispatch_resume(server);

    dispatch_source_t idle = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, queue);
    dispatch_source_set_timer(idle, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(60 * NSEC_PER_SEC)),
                              (uint64_t)(60 * NSEC_PER_SEC), (uint64_t)(5 * NSEC_PER_SEC));
    dispatch_source_set_event_handler(idle, ^{
      if ([NSDate timeIntervalSinceReferenceDate] - lastActivity > kIdleTimeout) {
        exit(0);
      }
    });
    dispatch_resume(idle);

    dispatch_main();
  }
  return 0;
}
