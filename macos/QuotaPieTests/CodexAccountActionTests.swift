import Foundation
import XCTest
@testable import QuotaPie

final class CodexAccountActionTests: XCTestCase {
    private let primary = CodexDesktopProfile(id: "primary", name: "Primary",
        codexHome: "/tmp/quotapie-account-action/primary-home", appData: "/tmp/quotapie-account-action/primary-app")
    private let isolated = CodexDesktopProfile(id: "secondary", name: "heznpc",
        codexHome: "/tmp/quotapie-account-action/secondary-home", appData: "/tmp/quotapie-account-action/secondary-app",
        collectionAccount: "secondary")

    func testPrimaryOpensUnifiedAppWithoutClaimingTheSelectedAccount() {
        let action = presentation(primary)
        XCTAssertTrue(action.isEnabled)
        XCTAssertEqual(action.launchProfile, primary)
        XCTAssertTrue(action.opensUnifiedApp)
        XCTAssertEqual(action.title, Strings.t("profiles.openUnifiedApp"))
        XCTAssertEqual(action.help, Strings.t("profiles.openUnifiedAppHelp"))
        XCTAssertFalse(action.title.contains(primary.name))
    }

    func testCredentialOnlyAccountUsesActualWorkDestination() throws {
        var account = isolated
        account.credentialOnly = true
        let action = presentation(account)
        XCTAssertEqual(action.launchProfile, try account.launchProfile(intent: .work, consolidation: nil, primary: primary))
        XCTAssertEqual(action.launchProfile, primary)
        XCTAssertTrue(action.opensUnifiedApp)
        XCTAssertEqual(action.title, Strings.t("profiles.openUnifiedApp"))
        XCTAssertEqual(action.help, Strings.t("profiles.openUnifiedAppHelp"))
        XCTAssertFalse(action.title.contains(account.name))
        XCTAssertFalse(action.help.contains(account.name))
    }

    func testVerifiedConsolidationOpensUnifiedAppAndRetainsOriginalProfile() throws {
        let consolidation = snapshot(state: "complete", source: isolated)
        let action = presentation(isolated, consolidation: consolidation)
        XCTAssertEqual(action.launchProfile,
            try isolated.launchProfile(intent: .work, consolidation: consolidation, primary: primary))
        XCTAssertEqual(action.launchProfile, primary)
        XCTAssertTrue(action.opensUnifiedApp)
        XCTAssertEqual(action.title, Strings.t("profiles.openUnifiedApp"))
        XCTAssertEqual(isolated.collectionAccount, "secondary")
        XCTAssertFalse(action.title.contains(isolated.name))
    }

    func testGenuinelyIsolatedProfileNamesItsOwnApp() {
        let action = presentation(isolated)
        XCTAssertTrue(action.isEnabled)
        XCTAssertFalse(action.opensUnifiedApp)
        XCTAssertEqual(action.launchProfile, isolated)
        XCTAssertEqual(action.title, Strings.t("profiles.openAccount", isolated.name))
        XCTAssertEqual(action.help, Strings.t("profiles.openIsolatedAccountHelp", isolated.name))
    }

    func testPendingOrUnrelatedConsolidationDoesNotInventRedirect() {
        let unrelated = CodexDesktopProfile(id: "other", name: "Other",
            codexHome: "/tmp/quotapie-account-action/other-home", appData: "/tmp/quotapie-account-action/other-app")
        for consolidation in [snapshot(state: "waiting-for-source-exit", source: isolated),
                              snapshot(state: "complete", source: unrelated)] {
            let action = presentation(isolated, consolidation: consolidation)
            XCTAssertEqual(action.launchProfile, isolated)
            XCTAssertFalse(action.opensUnifiedApp)
            XCTAssertEqual(action.title, Strings.t("profiles.openAccount", isolated.name))
        }
    }

    func testMissingProfileCannotClaimAnotherAccountsApp() {
        let action = presentation(nil)
        XCTAssertFalse(action.isEnabled)
        XCTAssertNil(action.launchProfile)
        XCTAssertFalse(action.opensUnifiedApp)
        XCTAssertEqual(action.title, Strings.t("profiles.open"))
        XCTAssertEqual(action.help, Strings.t("profiles.accountNotLinked"))
    }

    func testUnverifiedConsolidationCannotAdvertiseAWorkDestination() {
        var credentialOnly = isolated
        credentialOnly.credentialOnly = true
        for profile in [isolated, credentialOnly] {
            for consolidation in [nil, snapshot(state: "complete", source: profile)] {
                let action = presentation(profile, consolidation: consolidation, requiresVerification: true)
                XCTAssertFalse(action.isEnabled)
                XCTAssertNil(action.launchProfile)
                XCTAssertFalse(action.opensUnifiedApp)
                XCTAssertEqual(action.title, Strings.t("profiles.open"))
                XCTAssertEqual(action.help, Strings.t("profiles.error.consolidationUnavailable"))
            }
        }
    }

    func testProfileNameAndIDDoNotDetermineWhetherItsAppIsUnified() {
        var renamed = primary
        renamed.name = isolated.name
        XCTAssertTrue(presentation(renamed).opensUnifiedApp)
        let misleadingID = CodexDesktopProfile(id: "primary", name: "Primary",
            codexHome: isolated.codexHome, appData: isolated.appData)
        XCTAssertFalse(presentation(misleadingID).opensUnifiedApp)
        XCTAssertEqual(presentation(misleadingID).launchProfile, misleadingID)
    }

    private func presentation(_ profile: CodexDesktopProfile?, consolidation: CodexSessionConsolidation? = nil,
                              requiresVerification: Bool = false) -> CodexAccountAction {
        CodexAccountAction(profile: profile, consolidation: consolidation,
            requiresVerification: requiresVerification, primary: primary)
    }

    private func snapshot(state: String, source: CodexDesktopProfile) -> CodexSessionConsolidation {
        CodexSessionConsolidation(version: 1, state: state,
            primary: .init(codexHome: primary.codexHome, appData: primary.appData),
            sources: [.init(codexHome: CodexDesktopProfile.canonical(source.codexHome),
                            appData: CodexDesktopProfile.canonical(source.appData))],
            completedAtMs: state == "complete" ? 1000 : nil)
    }
}
