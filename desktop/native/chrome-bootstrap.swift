import Foundation
import Darwin

// WorkFoldChromeOrigin is generated from the checked distribution identity at
// build time. This process never mutates connection state or controls Chrome.
let maximumRequestBytes = 16 * 1024
let maximumResponseBytes = 64 * 1024

func reply(_ value: [String: Any]) {
    guard let bytes = try? JSONSerialization.data(withJSONObject: value), bytes.count <= maximumResponseBytes else { exit(1) }
    var length = UInt32(bytes.count).littleEndian
    withUnsafeBytes(of: &length) { FileHandle.standardOutput.write(Data($0)) }
    FileHandle.standardOutput.write(bytes)
}
func fail(_ state: String) -> Never {
    reply(["version": 1, "state": "status", "status": ["state": state, "checkedAt": ISO8601DateFormatter().string(from: Date())]])
    exit(0)
}
func readExactly(_ count: Int) -> Data? {
    var bytes = Data()
    while bytes.count < count {
        guard let part = try? FileHandle.standardInput.read(upToCount: count - bytes.count), !part.isEmpty else { return nil }
        bytes.append(part)
    }
    return bytes
}
func privateDescriptor(_ url: URL) -> [String: Any]? {
    let descriptor = open(url.path, O_RDONLY | O_NOFOLLOW)
    guard descriptor >= 0 else { return nil }
    defer { close(descriptor) }
    var attributes = stat()
    guard fstat(descriptor, &attributes) == 0,
          attributes.st_uid == getuid(), attributes.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
          attributes.st_mode & 0o077 == 0, attributes.st_size > 0, attributes.st_size <= maximumRequestBytes else { return nil }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: false)
    guard let bytes = try? handle.readToEnd(), let value = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { return nil }
    return value
}

// Chrome passes its caller origin as argv[1]. It does not pass a profile ID.
guard !WorkFoldChromeOrigin.isEmpty else { fail("store_unavailable") }
guard CommandLine.arguments.count == 2, CommandLine.arguments[1] == WorkFoldChromeOrigin else { fail("connection_error") }
// A truncated client must not leave an orphaned native helper process forever.
signal(SIGALRM, SIG_DFL)
alarm(10)
guard let header = readExactly(4) else { fail("connection_error") }
let count = header.enumerated().reduce(UInt32(0)) { $0 | UInt32($1.element) << ($1.offset * 8) }
guard count > 0, count <= maximumRequestBytes, let body = readExactly(Int(count)),
      let request = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { fail("connection_error") }
if request["version"] as? Int == 1, request["action"] as? String == "open-app" {
    let opener = Process()
    opener.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    opener.arguments = ["-b", "com.work-fold.desktop"]
    opener.standardInput = FileHandle.nullDevice
    opener.standardOutput = FileHandle.nullDevice
    opener.standardError = FileHandle.nullDevice
    do { try opener.run(); opener.waitUntilExit() } catch { fail("app_not_running") }
    fail(opener.terminationStatus == 0 ? "connecting" : "app_not_running")
}
let executable = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.resolvingSymlinksInPath()
let descriptorURL = executable.deletingLastPathComponent().appendingPathComponent("launch.json")
guard let descriptor = privateDescriptor(descriptorURL), descriptor["version"] as? Int == 1,
      let launchId = descriptor["launchId"] as? String, UUID(uuidString: launchId) != nil,
      let token = descriptor["bootstrapToken"] as? String, token.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
      let endpoint = descriptor["endpoint"] as? String, let parts = URLComponents(string: endpoint),
      parts.scheme == "http", parts.host == "127.0.0.1", let port = parts.port, port > 0, port <= 65535,
      parts.path == "/bootstrap", parts.query == nil, parts.fragment == nil, parts.user == nil, parts.password == nil,
      let url = parts.url else { fail("app_not_running") }

let envelope: [String: Any] = ["version": 1, "launchId": launchId, "extensionOrigin": WorkFoldChromeOrigin, "request": request]
guard let payload = try? JSONSerialization.data(withJSONObject: envelope) else { fail("connection_error") }
var outgoing = URLRequest(url: url)
outgoing.httpMethod = "POST"
outgoing.timeoutInterval = 5
outgoing.setValue("application/json", forHTTPHeaderField: "Content-Type")
outgoing.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
outgoing.httpBody = payload
let configuration = URLSessionConfiguration.ephemeral
configuration.connectionProxyDictionary = [:]
configuration.httpCookieStorage = nil
configuration.urlCache = nil
configuration.timeoutIntervalForRequest = 5
configuration.timeoutIntervalForResource = 5
// Never follow a redirect carrying the bootstrap bearer to another endpoint.
final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
let session = URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
let completed = DispatchSemaphore(value: 0)
var result: [String: Any] = ["version": 1, "state": "status", "status": ["state": "app_not_running", "checkedAt": ISO8601DateFormatter().string(from: Date())]]
let task = session.dataTask(with: outgoing) { bytes, response, error in
    defer { completed.signal() }
    guard error == nil, let response = response as? HTTPURLResponse, response.statusCode == 200,
          let bytes, bytes.count <= maximumResponseBytes,
          let value = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any], value["version"] as? Int == 1 else { return }
    result = value
}
task.resume()
guard completed.wait(timeout: .now() + 6) == .success else { task.cancel(); fail("app_not_running") }
session.finishTasksAndInvalidate()
reply(result)
