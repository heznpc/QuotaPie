import Foundation

/// Only selected-account metadata crosses the helper boundary.
public func verifiedAccessSummary(_ payload: [String: Any], organizationID: String) throws -> [String: Any] {
    _ = try verifiedAccount(payload, organizationID: organizationID)
    let account = payload["account"] as! [String: Any]
    let memberships = account["memberships"] as! [[String: Any]]
    let selected = memberships.filter { (($0["organization"] as? [String: Any])?["uuid"] as? String)?.lowercased() == organizationID.lowercased() }
    guard selected.count == 1, let membership = selected.first,
          let organization = membership["organization"] as? [String: Any] else {
        throw DesktopFailure("account-mismatch", "Claude organization could not be verified")
    }
    func text(_ value: Any?) -> String? {
        guard let value = value as? String, !value.isEmpty, value.count <= 200,
              !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return nil }
        return value
    }
    var result: [String: Any] = [:]
    if let value = text(organization["name"]) { result["organizationName"] = value }
    if let value = text(membership["role"]) { result["role"] = value }
    if let value = text(account["email_address"]) { result["email"] = value }
    return result
}
