import Foundation
import Security
import CommonCrypto
import SQLite3

public struct DesktopFailure: Error {
    public let category: String
    public let message: String
    public init(_ category: String, _ message: String) { self.category = category; self.message = message }
}

// This process is the only place desktop credentials are handled. Neither the
// collector nor its logs receive the encryption key or session cookies.
public struct DesktopSession: Equatable {
    let sessionKey: String
    public let organizationID: String

    public static func read(allowInteraction: Bool) throws -> DesktopSession {
        SecKeychainSetUserInteractionAllowed(allowInteraction)
        defer { SecKeychainSetUserInteractionAllowed(false) }
        var item: CFTypeRef?
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "Claude Safe Storage",
            kSecAttrAccount as String: "Claude",
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, var password = item as? Data else {
            if status == errSecItemNotFound { throw DesktopFailure("auth-required", "Claude desktop session was not found") }
            throw DesktopFailure("claude-desktop-keychain", "Allow QuotaPie to read the Claude desktop session in Keychain")
        }
        defer { password.resetBytes(in: 0..<password.count) }
        return try readCookies(password: password)
    }

    static func readCookies(password: Data, path: String = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Claude/Cookies").path, now: Date = Date()) throws -> DesktopSession {
        var db: OpaquePointer?
        // Normal read-only SQLite includes the WAL. Never copy just the main DB
        // or use immutable=1: that can resurrect a logged-out session.
        guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX, nil) == SQLITE_OK else {
            if let db { sqlite3_close(db) }
            throw DesktopFailure("auth-required", "Open Claude and sign in before connecting")
        }
        defer { sqlite3_close(db) }
        sqlite3_busy_timeout(db, 250)
        guard sqlite3_exec(db, "BEGIN", nil, nil, nil) == SQLITE_OK else { throw DesktopFailure("provider-error", "Claude session database is busy") }
        defer { sqlite3_exec(db, "ROLLBACK", nil, nil, nil) }
        var versionStatement: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT value FROM meta WHERE key='version'", -1, &versionStatement, nil) == SQLITE_OK else {
            throw DesktopFailure("provider-error", "Claude session format is unsupported")
        }
        defer { sqlite3_finalize(versionStatement) }
        guard sqlite3_step(versionStatement) == SQLITE_ROW else { throw DesktopFailure("provider-error", "Claude session format is unsupported") }
        let version = Int(sqlite3_column_int(versionStatement, 0))
        guard (24...24).contains(version) else { throw DesktopFailure("provider-error", "Claude session format is unsupported") }
        var statement: OpaquePointer?
        let sql = "SELECT name, encrypted_value, expires_utc, is_persistent, is_httponly FROM cookies WHERE host_key='.claude.ai' AND path='/' AND is_secure=1 AND top_frame_site_key='' AND name IN ('sessionKey','lastActiveOrg')"
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { throw DesktopFailure("provider-error", "Claude session format is unsupported") }
        defer { sqlite3_finalize(statement) }
        var values: [String: String] = [:]
        var step = sqlite3_step(statement)
        while step == SQLITE_ROW {
            guard let nameBytes = sqlite3_column_text(statement, 0) else { throw DesktopFailure("provider-error", "Claude session is invalid") }
            let name = String(cString: nameBytes)
            guard values[name] == nil else { throw DesktopFailure("provider-error", "Claude session is ambiguous") }
            let size = Int(sqlite3_column_bytes(statement, 1))
            guard size > 3, size <= 16_384, let bytes = sqlite3_column_blob(statement, 1) else { throw DesktopFailure("provider-error", "Claude session is invalid") }
            let expires = Double(sqlite3_column_int64(statement, 2)) / 1_000_000 - 11_644_473_600
            if sqlite3_column_int(statement, 3) != 0 && expires <= now.timeIntervalSince1970 {
                throw DesktopFailure("auth-expired", "Claude desktop session expired")
            }
            if name == "sessionKey" && sqlite3_column_int(statement, 4) == 0 { throw DesktopFailure("provider-error", "Claude session is invalid") }
            values[name] = try decryptCookie(Data(bytes: bytes, count: size), password: password, host: ".claude.ai", version: version)
            step = sqlite3_step(statement)
        }
        guard step == SQLITE_DONE else { throw DesktopFailure("provider-error", "Claude session could not be read") }
        guard let key = values["sessionKey"], !key.isEmpty, key.utf8.count <= 8192,
              key.utf8.allSatisfy({ $0 > 32 && $0 < 127 && $0 != 59 && $0 != 44 }),
              let org = values["lastActiveOrg"], isUUID(org) else {
            throw DesktopFailure("auth-required", "Open Claude and sign in before connecting")
        }
        return DesktopSession(sessionKey: key, organizationID: org.lowercased())
    }

    static func decryptCookie(_ encrypted: Data, password: Data, host: String, version: Int) throws -> String {
        guard encrypted.starts(with: Data("v10".utf8)), encrypted.count > 3,
              (encrypted.count - 3).isMultiple(of: kCCBlockSizeAES128) else { throw DesktopFailure("provider-error", "Claude cookie encryption is unsupported") }
        var key = Data(count: 16)
        defer { key.resetBytes(in: 0..<key.count) }
        let salt = Data("saltysalt".utf8)
        let derivation = key.withUnsafeMutableBytes { out in
            password.withUnsafeBytes { passwordBytes in
                salt.withUnsafeBytes { saltBytes in
                    CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), passwordBytes.baseAddress?.assumingMemoryBound(to: Int8.self), password.count,
                        saltBytes.baseAddress?.assumingMemoryBound(to: UInt8.self), salt.count, CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA1), 1003,
                        out.baseAddress?.assumingMemoryBound(to: UInt8.self), 16)
                }
            }
        }
        guard derivation == kCCSuccess else { throw DesktopFailure("provider-error", "Claude session could not be decrypted") }
        let ciphertext = encrypted.dropFirst(3)
        var plaintext = Data(count: ciphertext.count + kCCBlockSizeAES128)
        defer { plaintext.resetBytes(in: 0..<plaintext.count) }
        let capacity = plaintext.count
        var written = 0
        let iv = Data(repeating: 32, count: 16)
        let result = plaintext.withUnsafeMutableBytes { output in
            key.withUnsafeBytes { keyBytes in
                ciphertext.withUnsafeBytes { input in
                    iv.withUnsafeBytes { ivBytes in
                        CCCrypt(CCOperation(kCCDecrypt), CCAlgorithm(kCCAlgorithmAES), CCOptions(kCCOptionPKCS7Padding),
                            keyBytes.baseAddress, 16, ivBytes.baseAddress, input.baseAddress, ciphertext.count,
                            output.baseAddress, capacity, &written)
                    }
                }
            }
        }
        guard result == kCCSuccess else { throw DesktopFailure("provider-error", "Claude session could not be decrypted") }
        plaintext.count = written
        if version >= 24 {
            var digest = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
            let hostBytes = Data(host.utf8)
            _ = hostBytes.withUnsafeBytes { CC_SHA256($0.baseAddress, CC_LONG(hostBytes.count), &digest) }
            guard plaintext.count >= digest.count, Data(plaintext.prefix(digest.count)) == Data(digest) else {
                throw DesktopFailure("provider-error", "Claude cookie host did not match")
            }
            plaintext.removeFirst(digest.count)
        }
        guard let value = String(data: plaintext, encoding: .utf8) else { throw DesktopFailure("provider-error", "Claude session is invalid") }
        return value
    }

    public var bootstrapRequest: URLRequest { request(path: "/api/bootstrap") }
    public var usageRequest: URLRequest { request(path: "/api/organizations/\(organizationID)/usage?skip_spend=1") }
    // The desktop app's alternate bootstrap path. Only explicit diagnostics use
    // this larger response; regular collection needs just identity and usage.
    public var appStartRequest: URLRequest {
        request(path: "/edge-api/bootstrap/\(organizationID)/app_start?statsig_hashing_algorithm=djb2&growthbook_format=sdk&cache_bust=1&include_system_prompts=false")
    }
    private func request(path: String) -> URLRequest {
        var request = URLRequest(url: URL(string: "https://claude.ai" + path)!)
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("sessionKey=\(sessionKey); lastActiveOrg=\(organizationID)", forHTTPHeaderField: "Cookie")
        return request
    }
}

public func isUUID(_ value: String) -> Bool {
    UUID(uuidString: value) != nil && value.count == 36
}

public func verifiedAccount(_ payload: [String: Any], organizationID: String) throws -> String {
    guard let account = payload["account"] as? [String: Any], let id = account["uuid"] as? String, isUUID(id),
          let memberships = account["memberships"] as? [[String: Any]],
          memberships.contains(where: { (($0["organization"] as? [String: Any])?["uuid"] as? String)?.lowercased() == organizationID.lowercased() }) else {
        throw DesktopFailure("access-denied", "Claude account does not match the active organization")
    }
    return id.lowercased()
}

// Claude's desktop renderer classifies the selected organization's capabilities,
// not an absent usage window or billing record. Keep this projection independent
// of quota availability and never expose the rest of the bootstrap response.
public func verifiedPlan(_ payload: [String: Any], organizationID: String) throws -> String {
    _ = try verifiedAccount(payload, organizationID: organizationID)
    let account = payload["account"] as! [String: Any]
    let memberships = account["memberships"] as! [[String: Any]]
    let organizations = memberships.compactMap { $0["organization"] as? [String: Any] }
        .filter { ($0["uuid"] as? String)?.lowercased() == organizationID.lowercased() }
    guard organizations.count == 1, let org = organizations.first,
          let capabilities = org["capabilities"] as? [String], !capabilities.isEmpty,
          capabilities.count <= 128,
          capabilities.allSatisfy({ shortString($0) != nil }) else { return "unknown" }
    let caps = Set(capabilities)
    guard caps.contains("chat"), !caps.contains("api") else { return "unknown" }
    if caps.contains("raven") {
        guard let type = org["raven_type"] as? String else { return "unknown" }
        // Fail closed for new organization types instead of calling them Team.
        switch type {
        case "enterprise": return "enterprise"
        case "team": return "team"
        default: return "unknown"
        }
    }
    if caps.contains("claude_max") { return "max" }
    if caps.contains("claude_pro") { return "pro" }
    // Free has only the consumer chat capability. Additional unrecognized
    // capabilities may represent a new paid tier; never silently call it Free.
    return caps == Set(["chat"]) ? "free" : "unknown"
}

// Inspect only server-supplied limit metadata for the exact selected org. The
// renderer merges cached state into bootstrap; such cache is not current proof.
// This projection is diagnostic, never a percentage or a recovery assertion.
public func limitMetadata(_ payload: [String: Any], organizationID: String) -> [String: Any] {
    guard let limits = payload["messageLimits"] as? [String: Any],
          let entry = limits[organizationID] as? [String: Any] else {
        return ["provided": false]
    }
    var result: [String: Any] = ["provided": true]
    if let type = entry["type"] as? String, ["within_limit", "approaching_limit", "exceeded_limit"].contains(type) { result["type"] = type }
    for key in ["resetsAt", "resets_at"] {
        if let date = timestamp(entry[key]) { result[key] = date }
        else if let number = entry[key] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite, number.doubleValue > 0 { result[key] = number }
    }
    if let windows = entry["windows"] as? [String: Any] {
        var projected: [String: Any] = [:]
        for key in ["5h", "7d"] {
            guard let window = windows[key] as? [String: Any] else { continue }
            var safe: [String: Any] = [:]
            if let status = window["status"] as? String, ["within_limit", "approaching_limit", "exceeded_limit"].contains(status) { safe["status"] = status }
            if let date = timestamp(window["resets_at"]) { safe["resets_at"] = date }
            else if let number = window["resets_at"] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite, number.doubleValue > 0 { safe["resets_at"] = number }
            if !safe.isEmpty { projected[key] = safe }
        }
        if !projected.isEmpty { result["windows"] = projected }
    }
    return result
}

// Provider responses may contain personal data or future unknown fields.
// Send only known quota fields across the helper boundary.
public func sanitizedUsage(_ payload: [String: Any]) throws -> [String: Any] {
    let windowKeys = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_oauth_apps", "seven_day_cowork", "seven_day_omelette", "omelette_promotional"]
    let invalid = DesktopFailure("provider-error", "Claude usage response format is unsupported")
    guard payload.isEmpty || payload.keys.contains(where: { windowKeys.contains($0) || $0 == "limits" || $0 == "extra_usage" }) else { throw invalid }
    var result: [String: Any] = [:]
    for key in windowKeys {
        guard let raw = payload[key] else { continue }
        if payload[key] is NSNull { result[key] = NSNull(); continue }
        guard let value = raw as? [String: Any] else { throw invalid }
        var window: [String: Any] = [:]
        if let n = percent(value["utilization"]) { window["utilization"] = n }
        else if value["utilization"] is NSNull { window["utilization"] = NSNull() }
        else { throw invalid }
        if let date = timestamp(value["resets_at"]) { window["resets_at"] = date }
        else if value["resets_at"] is NSNull { window["resets_at"] = NSNull() }
        else if value["resets_at"] != nil { throw invalid }
        result[key] = window
    }
    if let raw = payload["limits"] {
        if raw is NSNull { result["limits"] = []; return result }
        guard let limits = raw as? [[String: Any]], limits.count <= 128 else { throw invalid }
        result["limits"] = try limits.map { value -> [String: Any] in
            guard let kind = shortString(value["kind"]), let group = shortString(value["group"]), let n = percent(value["percent"]) else { throw invalid }
            var limit: [String: Any] = ["kind": kind, "group": group, "percent": n]
            if let date = timestamp(value["resets_at"]) { limit["resets_at"] = date }
            else if let rawDate = value["resets_at"], !(rawDate is NSNull) { throw invalid }
            if let severity = shortString(value["severity"]) { limit["severity"] = severity }
            else if value["severity"] != nil { throw invalid }
            if let rawScope = value["scope"], !(rawScope is NSNull) {
                guard let scope = rawScope as? [String: Any] else { throw invalid }
                var safe: [String: Any] = [:]
                for key in ["model", "surface"] {
                    if let rawEntry = scope[key], !(rawEntry is NSNull) {
                        guard let entry = rawEntry as? [String: Any], let name = shortString(entry["display_name"]) else { throw invalid }
                        safe[key] = ["display_name": name]
                    }
                }
                limit["scope"] = safe
            }
            return limit
        }
    }
    return result
}

private func percent(_ value: Any?) -> Double? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    let n = number.doubleValue
    return n.isFinite && n >= 0 && n <= 100 ? n : nil
}
private func shortString(_ value: Any?) -> String? {
    guard let text = value as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.utf8.count <= 120, !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return nil }
    return text
}
private func timestamp(_ value: Any?) -> String? {
    guard let text = value as? String, text.count <= 40 else { return nil }
    let formatter = ISO8601DateFormatter()
    if formatter.date(from: text) != nil { return text }
    formatter.formatOptions.insert(.withFractionalSeconds)
    return formatter.date(from: text) != nil ? text : nil
}
