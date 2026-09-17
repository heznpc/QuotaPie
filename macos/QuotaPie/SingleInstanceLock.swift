import Darwin
import Foundation

/// The descriptor owns the lock for the app's lifetime, across bundle locations.
/// Do not unlink the file: another process may already be waiting on its inode.
final class SingleInstanceLock {
    private var descriptor: Int32 = -1

    func acquire(at directory: URL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/QuotaPie", isDirectory: true)) throws -> Bool {
        guard descriptor == -1 else { return true }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                               attributes: [.posixPermissions: 0o700])
        let path = directory.appendingPathComponent("menubar.lock").path
        let fd = Darwin.open(path, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            let code = errno
            Darwin.close(fd)
            if code == EWOULDBLOCK { return false }
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(code))
        }
        descriptor = fd
        return true
    }

    deinit {
        if descriptor >= 0 { Darwin.close(descriptor) }
    }
}
