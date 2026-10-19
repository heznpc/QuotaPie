import XCTest
import CommonCrypto
import SQLite3
@testable import ClaudeDesktopCore

final class ClaudeDesktopSessionTests: XCTestCase {
    private let password = Data("test-only-password".utf8)
    private let org = "11111111-2222-4333-8444-555555555555"
    private let account = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"

    private func encrypt(_ text: String, host: String = ".claude.ai") -> Data {
        var key = [UInt8](repeating: 0, count: 16)
        let salt = Array("saltysalt".utf8)
        _ = password.withUnsafeBytes { bytes in
            CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), bytes.baseAddress!.assumingMemoryBound(to: Int8.self), password.count,
                salt, salt.count, CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA1), 1003, &key, 16)
        }
        var hash = [UInt8](repeating: 0, count: 32)
        let hostData = Data(host.utf8)
        _ = hostData.withUnsafeBytes { CC_SHA256($0.baseAddress, CC_LONG(hostData.count), &hash) }
        let plain = Data(hash) + Data(text.utf8), iv = [UInt8](repeating: 32, count: 16)
        var result = [UInt8](repeating: 0, count: plain.count + 16), written = 0
        let capacity = result.count
        _ = plain.withUnsafeBytes { bytes in CCCrypt(CCOperation(kCCEncrypt), CCAlgorithm(kCCAlgorithmAES), CCOptions(kCCOptionPKCS7Padding),
            key, 16, iv, bytes.baseAddress, plain.count, &result, capacity, &written) }
        return Data("v10".utf8) + Data(result.prefix(written))
    }

    func testCookieDecryptionAndHostBinding() throws {
        XCTAssertEqual(try DesktopSession.decryptCookie(encrypt("fixture-session"), password: password, host: ".claude.ai", version: 24), "fixture-session")
        XCTAssertThrowsError(try DesktopSession.decryptCookie(encrypt("fixture-session", host: ".example.com"), password: password, host: ".claude.ai", version: 24))
        XCTAssertThrowsError(try DesktopSession.decryptCookie(Data("v20bad".utf8), password: password, host: ".claude.ai", version: 24))
        XCTAssertThrowsError(try DesktopSession.decryptCookie(encrypt("fixture-session").dropLast(), password: password, host: ".claude.ai", version: 24))
    }

    func testBootstrapRequiresSelectedOrganizationMembership() throws {
        let payload: [String: Any] = ["account": ["uuid": account, "memberships": [["organization": ["uuid": org]]]]]
        XCTAssertEqual(try verifiedAccount(payload, organizationID: org), account)
        XCTAssertThrowsError(try verifiedAccount(payload, organizationID: account))
        XCTAssertThrowsError(try verifiedAccount(["account": ["uuid": account]], organizationID: org))
    }

    func testUsageWhitelistKeepsEmptyAndRealWindowsWithoutPrivateFields() throws {
        let input: [String: Any] = ["five_hour": NSNull(), "seven_day": ["utilization": 12.0, "resets_at": "2026-10-21T10:00:00Z", "secret": "private"], "email": "private",
            "limits": [["kind": "session", "group": "default", "percent": 33, "resets_at": "2026-10-20T12:00:00.123Z", "scope": ["model": ["display_name": "Sonnet", "secret": "private"]], "secret": "private"]]]
        let value = try sanitizedUsage(input)
        XCTAssertTrue(value["five_hour"] is NSNull)
        XCTAssertEqual((value["seven_day"] as? [String: Any])?["utilization"] as? Double, 12)
        XCTAssertNil(value["email"])
        let serialized = String(data: try! JSONSerialization.data(withJSONObject: value), encoding: .utf8)!
        XCTAssertFalse(serialized.contains("private"))
        XCTAssertEqual(try sanitizedUsage([:]).count, 0)
        XCTAssertThrowsError(try sanitizedUsage(["five_hour": ["utilization": true]]))
        XCTAssertThrowsError(try sanitizedUsage(["five_hour": ["utilization": 101]]))
        XCTAssertThrowsError(try sanitizedUsage(["error": "private"] ))
        XCTAssertThrowsError(try sanitizedUsage(["limits": [["kind": "session", "group": "default", "percent": "1"]]]))
    }

    func testCookiesReadWALAndRejectLogoutExpiryAndAmbiguity() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent("Cookies").path
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open(path, &db), SQLITE_OK)
        defer { sqlite3_close(db) }
        func sql(_ query: String) { XCTAssertEqual(sqlite3_exec(db, query, nil, nil, nil), SQLITE_OK) }
        sql("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE meta (key TEXT,value TEXT); INSERT INTO meta VALUES ('version','24'); CREATE TABLE cookies (name TEXT, encrypted_value BLOB, host_key TEXT DEFAULT '.claude.ai', path TEXT DEFAULT '/', is_secure INT DEFAULT 1, top_frame_site_key TEXT DEFAULT '', expires_utc INTEGER DEFAULT 99999999999999999,is_persistent INT DEFAULT 1,is_httponly INT DEFAULT 1)")
        func insert(_ name: String, _ value: String) {
            let hex = encrypt(value).map { String(format: "%02x", $0) }.joined()
            sql("INSERT INTO cookies(name,encrypted_value) VALUES ('\(name)',X'\(hex)')")
        }
        insert("sessionKey", "fixture-session"); insert("lastActiveOrg", org)
        let first = try DesktopSession.readCookies(password: password, path: path)
        XCTAssertEqual(first.organizationID, org)
        XCTAssertEqual(first.usageRequest.url?.host, "claude.ai")
        XCTAssertEqual(first.usageRequest.url?.query, "skip_spend=1")
        sql("DELETE FROM cookies WHERE name='sessionKey'")
        XCTAssertThrowsError(try DesktopSession.readCookies(password: password, path: path))
        insert("sessionKey", "fixture-new-session")
        XCTAssertNotEqual(try DesktopSession.readCookies(password: password, path: path), first)
        sql("UPDATE cookies SET expires_utc=1 WHERE name='sessionKey'")
        XCTAssertThrowsError(try DesktopSession.readCookies(password: password, path: path))
        sql("UPDATE cookies SET expires_utc=99999999999999999")
        insert("sessionKey", "duplicate")
        XCTAssertThrowsError(try DesktopSession.readCookies(password: password, path: path))
    }
}
