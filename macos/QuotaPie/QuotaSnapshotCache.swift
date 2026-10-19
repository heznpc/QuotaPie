import Foundation

/// A display-only startup aid. This schema cannot encode action capabilities,
/// task/goal state, prompts, or account credentials.
struct QuotaSnapshotCache {
    let url: URL
    let endpoint: String

    init(endpoint: String, url: URL? = nil) {
        self.endpoint = endpoint
        self.url = url ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("local.quotapie.menubar/quota-display-v1.json")
    }

    private struct Snapshot: Codable {
        let version: Int
        let endpoint: String
        let nowMs: Double
        let accounts: [AccountState]
    }

    func save(_ payload: StatusPayload) throws {
        guard let nowMs = payload.nowMs, nowMs.isFinite, nowMs > 0 else { return }
        var accounts = payload.accounts
        for index in accounts.indices {
            accounts[index].collection.health = "stale-success"
            accounts[index].collection.errorCategory = "stale-success"
            accounts[index].collection.errorDetail = nil
            for window in accounts[index].windows.indices { accounts[index].windows[window].freshness = "stale" }
        }
        let data = try JSONEncoder().encode(Snapshot(version: 1, endpoint: endpoint, nowMs: nowMs, accounts: accounts))
        guard data.count <= 512 * 1_024 else { return }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
                                               attributes: [.posixPermissions: 0o700])
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    func load(now: Date = Date()) -> StatusPayload? {
        guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
              values.isRegularFile == true, values.isSymbolicLink != true, (values.fileSize ?? Int.max) <= 512 * 1_024,
              let data = try? Data(contentsOf: url),
              let saved = try? JSONDecoder().decode(Snapshot.self, from: data),
              saved.version == 1, saved.endpoint == endpoint,
              saved.nowMs > 0, saved.nowMs <= now.timeIntervalSince1970 * 1_000 + 1_000 else { return nil }
        // Decode the narrow schema again; unknown fields cannot acquire authority.
        guard var payload = try? JSONDecoder().decode(StatusPayload.self, from: JSONEncoder().encode(saved)) else { return nil }
        for index in payload.accounts.indices {
            payload.accounts[index].collection.health = "stale-success"
            payload.accounts[index].collection.errorCategory = "stale-success"
            payload.accounts[index].collection.errorDetail = nil
            for window in payload.accounts[index].windows.indices { payload.accounts[index].windows[window].freshness = "stale" }
        }
        return payload
    }
}
