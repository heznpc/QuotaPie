import Foundation
import XCTest
@testable import QuotaPie

final class QuotaRefreshTests: XCTestCase {
    private func status(time: Int = 1000, remaining: Int = 70, token: String = "live-token", details: Bool = false) throws -> StatusPayload {
        var json: [String: Any] = ["nowMs": time, "actionToken": token,
            "collection": ["refreshing": true, "lastStartedAtMs": time],
            "accounts": [["provider": "codex", "account": "fixture", "accountLabel": "Fixture", "enabled": true,
                "collection": ["health": "recent-success", "lastSuccessAtMs": time - 100, "errorDetail": "private-error"],
                "windows": [["provider": "codex", "account": "fixture", "bucket": "codex:primary:300", "label": "5h",
                    "windowSeconds": 18000, "freshness": "fresh", "observedAtMs": time - 100, "remainingPercent": remaining, "rapidDropPercent": 0, "rapidIntervalMinutes": 0]]]]]
        if details {
            json["accountPool"] = ["enabled": true, "accounts": ["fixture"], "recent": []]
            json["notificationPreferences"] = ["enabled": true, "topics": [:], "desktopEnabled": true, "resetCollectionEnabled": true]
            json["autoResume"] = ["accounts": [["account": "fixture", "label": "Fixture", "enabled": true]], "incidents": []]
        }
        return try JSONDecoder().decode(StatusPayload.self, from: JSONSerialization.data(withJSONObject: json))
    }

    func testQuotaPollRetainsDetailsAndLateDetailsCannotRestoreOlderQuotaOrToken() throws {
        let model = PopoverModel()
        model.applyStatus(try status(details: true), notificationRevision: 0)
        let revision = model.quotaRevision
        model.applyQuota(try status(time: 3000, remaining: 45, token: "new-token"))
        XCTAssertTrue(model.payload?.accountPool?.enabled == true)
        XCTAssertTrue(model.payload?.autoResume?.accounts.first?.enabled == true)
        XCTAssertTrue(model.payload?.notificationPreferences?.enabled == true)
        // Even a detail response generated later can contain older core data
        // if it began before the independent fast poll completed.
        model.applyStatus(try status(time: 4000, remaining: 65, token: "old-token", details: true),
                          notificationRevision: 0, quotaRevision: revision, poolRevision: 0)
        XCTAssertEqual(model.payload?.accounts.first?.windows.first?.remainingPercent, 45)
        XCTAssertEqual(model.payload?.nowMs, 3000)
        XCTAssertEqual(model.payload?.actionToken, "new-token")
        model.applyQuota(try status(time: 2000, remaining: 90, token: "older-token"))
        XCTAssertEqual(model.payload?.actionToken, "new-token")
        XCTAssertEqual(try XCTUnwrap(model.measurementDate).timeIntervalSince1970, 2.9, accuracy: 0.00001)
    }

    func testFastQuotaClearsReadyBadgeAndLateDetailsCannotResurrectIt() throws {
        let task = try JSONDecoder().decode(ResumeTask.self, from: Data(#"{"id":"00000000-0000-4000-8000-000000000001","provider":"codex","account":"fixture","accountLabel":"Fixture","projectLabel":"Ready job","state":"ready","registeredAtMs":100,"expectedResetAtMs":500}"#.utf8))
        var ready = try status(time:1000)
        ready.resumeTasks = [task]
        let model = PopoverModel()
        model.applyQuota(ready)
        XCTAssertEqual(model.activeTasks.map(\.id),[task.id])
        model.resumeActivities[task.id] = .failed("old attempt")
        let oldRequest = model.quotaRevision
        model.applyQuota(try status(time:2000))
        XCTAssertTrue(model.activeTasks.isEmpty)
        XCTAssertTrue(model.resumeActivities.isEmpty)
        // An independently delayed detail response still carries the old task.
        ready.nowMs = 3000
        model.applyStatus(ready,notificationRevision:0,quotaRevision:oldRequest)
        XCTAssertTrue(model.activeTasks.isEmpty)
        XCTAssertTrue(model.payload?.resumeTasks.isEmpty == true)
    }

    func testFastQuotaUpdatesAutoResumeAndCannotUndoAnAcknowledgedToggle() throws {
        let model = PopoverModel()
        model.applyQuota(try status(details: true))
        let oldDetailsRevision = model.quotaRevision
        var disabled = try status(time: 2000, details: true)
        disabled.autoResume = try JSONDecoder().decode(AutoResumePayload.self, from: Data(#"{"accounts":[{"account":"fixture","label":"Fixture","enabled":false}],"incidents":[]}"#.utf8))
        model.applyQuota(disabled)
        XCTAssertEqual(model.payload?.autoResume?.accounts[0].enabled, false)
        model.applyStatus(try status(time: 3000, details: true), notificationRevision: 0, quotaRevision: oldDetailsRevision)
        XCTAssertEqual(model.payload?.autoResume?.accounts[0].enabled, false, "Delayed details must not replace the latest fast observation")
        model.beginAutoResumeSave()
        model.applyQuota(try status(time: 4000, details: true))
        XCTAssertEqual(model.payload?.autoResume?.accounts[0].enabled, false)
        model.finishAutoResumeSave(disabled.autoResume, nowMs: 5000)
        model.applyQuota(try status(time: 4500, details: true))
        XCTAssertEqual(model.payload?.autoResume?.accounts[0].enabled, false)
        model.applyQuota(try status(time: 6000, details: true))
        XCTAssertEqual(model.payload?.autoResume?.accounts[0].enabled, true)
        model.applyQuota(try status(time: 7000))
        XCTAssertEqual(model.payload?.autoResume?.accounts[0].enabled, true, "Older backends can omit the optional field")
    }

    func testFastCompactionActivityPreservesSettingsSavedDuringTheRequest() throws {
        func snapshot(_ time: Int, model: String, enabled: Bool) throws -> StatusPayload {
            let json: [String: Any] = ["nowMs": time, "compaction": ["checkedAtMs": time, "generations": 1, "reachable": 1,
                "active": [], "recent": [], "policy": ["model": model, "effort": "low", "models": ["old", "new"], "configurable": true, "generations": 1, "applied": 1],
                "savings": ["policy": ["enabled": enabled, "testOnly": false, "configurable": true, "supported": true, "generations": 1, "compatible": 1, "applied": 1], "active": [], "recent": []]]]
            return try JSONDecoder().decode(StatusPayload.self, from: JSONSerialization.data(withJSONObject: json))
        }
        let model = PopoverModel()
        model.applyQuota(try snapshot(1000, model: "old", enabled: false))
        let savingsRevision = model.savingsPreferencesRevision, compactionRevision = model.compactionPreferencesRevision
        let saved = try snapshot(2000, model: "new", enabled: true)
        model.beginCompactionSave(); model.beginSavingsSave()
        model.finishCompactionSave(saved.compaction?.policy); model.finishSavingsSave(saved.compaction?.savings?.policy)
        model.applyQuota(try snapshot(3000, model: "old", enabled: false), savingsRevision: savingsRevision, compactionRevision: compactionRevision)
        XCTAssertEqual(model.payload?.compaction?.checkedAtMs, 3000)
        XCTAssertEqual(model.payload?.compaction?.policy?.model, "new")
        XCTAssertEqual(model.payload?.compaction?.savings?.policy?.enabled, true)
        model.applyStatus(try snapshot(2500, model: "old", enabled: false), notificationRevision: 0)
        XCTAssertEqual(model.payload?.compaction?.checkedAtMs, 3000)
        XCTAssertEqual(model.payload?.compaction?.policy?.model, "new")
        model.applyQuota(try snapshot(4000, model: "old", enabled: false), savingsRevision: model.savingsPreferencesRevision,
                         compactionRevision: model.compactionPreferencesRevision)
        XCTAssertEqual(model.payload?.compaction?.policy?.model, "old")
        XCTAssertEqual(model.payload?.compaction?.savings?.policy?.enabled, false)
    }

    func testRefreshAcknowledgementCannotResurrectCompletedCollectionOrChangeMeasurement() throws {
        func collection(_ json: String) throws -> CollectionRefreshState {
            try JSONDecoder().decode(CollectionRefreshState.self, from: Data(json.utf8))
        }
        let model = PopoverModel()
        model.applyQuota(try status())
        let measurement = model.measurementDate
        model.applyCollectionRefresh(try collection(#"{"refreshing":true,"requestedAtMs":2000,"lastStartedAtMs":2000}"#))
        XCTAssertTrue(model.payload?.collection?.refreshing == true)
        model.applyStatus(try status(time: 1500), notificationRevision: 0, quotaRevision: model.quotaRevision)
        XCTAssertEqual(model.payload?.collection?.lastStartedAtMs, 2000, "A late detail reply cannot undo the newer POST acknowledgement")
        model.applyQuota(try status(time: 1500))
        XCTAssertEqual(model.payload?.collection?.lastStartedAtMs, 2000)
        model.applyCollectionRefresh(try collection(#"{"refreshing":false,"lastStartedAtMs":2000,"lastFinishedAtMs":3000}"#))
        model.applyCollectionRefresh(try collection(#"{"refreshing":true,"requestedAtMs":2000,"lastStartedAtMs":2000,"nextAttemptAtMs":9000}"#))
        XCTAssertFalse(model.payload?.collection?.refreshing == true)
        XCTAssertEqual(model.payload?.accounts[0].windows[0].observedAtMs, 1400)
        XCTAssertEqual(try XCTUnwrap(measurement).timeIntervalSince1970, 0.9, accuracy: 0.00001)
        XCTAssertNil(model.lastError, "A running collector is not a transport failure")
        model.applyCollectionRefresh(try collection(#"{"refreshing":false,"requestedAtMs":4000,"lastStartedAtMs":4000,"lastFinishedAtMs":4000}"#))
        model.applyCollectionRefresh(try collection(#"{"refreshing":true,"requestedAtMs":4000,"lastStartedAtMs":4000}"#))
        XCTAssertFalse(model.payload?.collection?.refreshing == true, "Completion wins an equal-millisecond acknowledgement")
    }

    func testLateDetailsCannotReviveCompactionWhenStaleProjectionKeepsTheObservationTime() throws {
        func snapshot(time: Int, reachable: Int) throws -> StatusPayload {
            let json: [String: Any] = ["nowMs": time, "compaction": ["checkedAtMs": 1000,
                "generations": 1, "reachable": reachable, "active": [], "recent": []]]
            return try JSONDecoder().decode(StatusPayload.self, from: JSONSerialization.data(withJSONObject: json))
        }
        let model = PopoverModel()
        model.applyQuota(try snapshot(time: 1000, reachable: 1))
        let oldRequest = model.quotaRevision
        model.applyQuota(try snapshot(time: 12000, reachable: 0))
        XCTAssertEqual(model.payload?.compaction?.checkedAtMs, 1000)
        model.applyStatus(try snapshot(time: 2000, reachable: 1), notificationRevision: 0, quotaRevision: oldRequest)
        XCTAssertEqual(model.payload?.compaction?.reachable, 0)
    }

    func testNewerDetailCanMarkTheSameCompactionObservationStaleAfterQuotaOnlyPolling() throws {
        func snapshot(time: Int, reachable: Int) throws -> StatusPayload {
            let json: [String: Any] = ["nowMs": time, "compaction": ["checkedAtMs": 1000,
                "generations": 1, "reachable": reachable, "active": [], "recent": []]]
            return try JSONDecoder().decode(StatusPayload.self, from: JSONSerialization.data(withJSONObject: json))
        }
        let model = PopoverModel()
        model.applyQuota(try snapshot(time: 1000, reachable: 1))
        let detailRevision = model.quotaRevision
        // A quota-only response advances nowMs but makes no new compaction claim.
        model.applyQuota(try status(time: 13000))
        model.applyStatus(try snapshot(time: 12000, reachable: 0), notificationRevision: 0, quotaRevision: detailRevision)
        XCTAssertEqual(model.payload?.compaction?.reachable, 0)
        XCTAssertEqual(model.payload?.nowMs, 13000)
        model.applyStatus(try snapshot(time: 2000, reachable: 1), notificationRevision: 0, quotaRevision: detailRevision)
        XCTAssertEqual(model.payload?.compaction?.reachable, 0)
    }

    func testForecastsSurviveOnlyWhileFastQuotaReferencesTheSameObservation() throws {
        var rich = try status(details: true)
        var window = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(rich.accounts[0].windows[0])) as? [String: Any])
        window["paceRatio"] = 2.5
        window["recentBurnPerHour"] = 6
        window["riskLevel"] = "at-risk"
        window["rapidDropPercent"] = 3
        window["rapidIntervalMinutes"] = 4
        rich.accounts[0].windows[0] = try JSONDecoder().decode(QuotaWindow.self, from: JSONSerialization.data(withJSONObject: window))
        let model = PopoverModel()
        model.applyStatus(rich, notificationRevision: 0)
        model.applyQuota(try status())
        XCTAssertEqual(model.payload?.accounts[0].windows[0].paceRatio, 2.5)
        XCTAssertEqual(model.payload?.accounts[0].windows[0].recentBurnPerHour, 6)
        XCTAssertEqual(model.payload?.accounts[0].windows[0].riskLevel, "at-risk")
        XCTAssertEqual(model.payload?.accounts[0].windows[0].rapidDropPercent, 3)
        XCTAssertEqual(model.payload?.accounts[0].windows[0].rapidIntervalMinutes, 4)
        model.applyQuota(try status(time: 2000))
        XCTAssertNil(model.payload?.accounts[0].windows[0].paceRatio)
        XCTAssertNil(model.payload?.accounts[0].windows[0].recentBurnPerHour)
        XCTAssertEqual(model.payload?.accounts[0].windows[0].rapidDropPercent, 0)
        XCTAssertEqual(model.payload?.accounts[0].windows[0].rapidIntervalMinutes, 0)
    }

    func testLateDetailCannotOverwriteSavedPoolPreference() throws {
        let model = PopoverModel()
        model.applyStatus(try status(details: true), notificationRevision: 0)
        model.beginPoolSave()
        let revision = model.poolPreferencesRevision
        let disabled = try JSONDecoder().decode(AccountPoolPayload.self, from: Data(#"{"enabled":false,"accounts":[],"recent":[]}"#.utf8))
        model.finishPoolSave(disabled)
        model.applyStatus(try status(time: 3000, details: true), notificationRevision: 0, poolRevision: revision)
        XCTAssertEqual(model.payload?.accountPool?.enabled, false)
        model.applyStatus(try status(time: 4000, details: true), notificationRevision: 0, poolRevision: model.poolPreferencesRevision)
        XCTAssertEqual(model.payload?.accountPool?.enabled, true)
    }

    func testLateDetailCannotRevertAcknowledgedSavingsAndCompactionSettings() throws {
        func policyStatus(enabled: Bool, name: String, time: Int) throws -> StatusPayload {
            let json: [String: Any] = ["nowMs":time,"compaction":["checkedAtMs":time,"generations":1,"reachable":1,"active":[],"recent":[],
                "policy":["model":name,"effort":"low","models":["old","new"],"configurable":true,"generations":1,"applied":1],
                "savings":["policy":["enabled":enabled,"testOnly":enabled,"configurable":true,"supported":true,"generations":1,"compatible":1,"applied":1],"active":[],"recent":[]]]]
            return try JSONDecoder().decode(StatusPayload.self,from:JSONSerialization.data(withJSONObject:json))
        }
        for duringSave in [false,true] {
            let model = PopoverModel()
            let old = try policyStatus(enabled:false,name:"old",time:1000)
            let saved = try policyStatus(enabled:true,name:"new",time:2000)
            model.applyStatus(old,notificationRevision:0)
            var savingsRevision = model.savingsPreferencesRevision
            var compactionRevision = model.compactionPreferencesRevision
            model.beginSavingsSave()
            model.beginCompactionSave()
            if duringSave {
                savingsRevision = model.savingsPreferencesRevision
                compactionRevision = model.compactionPreferencesRevision
            }
            model.finishSavingsSave(saved.compaction?.savings?.policy)
            model.finishCompactionSave(saved.compaction?.policy)
            XCTAssertEqual(model.payload?.compaction?.policy?.model,"new")
            XCTAssertEqual(model.payload?.compaction?.savings?.policy?.enabled,true)
            model.applyStatus(try policyStatus(enabled:false,name:"old",time:3000),notificationRevision:0,
                              savingsRevision:savingsRevision,compactionRevision:compactionRevision)
            XCTAssertEqual(model.payload?.compaction?.policy?.model,"new")
            XCTAssertEqual(model.payload?.compaction?.savings?.policy?.enabled,true)
            XCTAssertEqual(model.payload?.compaction?.savings?.policy?.testOnly,true)
            XCTAssertEqual(model.payload?.compaction?.checkedAtMs,3000,"Keep unrelated fresh activity metadata")
            model.applyStatus(try policyStatus(enabled:false,name:"old",time:4000),notificationRevision:0,
                              savingsRevision:model.savingsPreferencesRevision,compactionRevision:model.compactionPreferencesRevision)
            XCTAssertEqual(model.payload?.compaction?.policy?.model,"old")
            XCTAssertEqual(model.payload?.compaction?.savings?.policy?.enabled,false)
            XCTAssertFalse(model.savingsSaving)
            XCTAssertFalse(model.compactionSaving)
        }
    }

    func testStartupCacheIsDisplayOnlyPreservesMeasurementAndCannotAuthorizeActions() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("quota.json")
        let cache = QuotaSnapshotCache(endpoint: "http://127.0.0.1:1", url: file)
        try cache.save(status(details: true))
        let raw = try String(contentsOf: file)
        for secret in ["actionToken", "live-token", "autoResume", "notificationPreferences", "accountPool", "resumeTasks", "private-error"] {
            XCTAssertFalse(raw.contains(secret), secret)
        }
        let payload = try XCTUnwrap(cache.load())
        XCTAssertNil(payload.actionToken)
        XCTAssertNil(payload.autoResume)
        XCTAssertNil(payload.accountPool)
        XCTAssertTrue(payload.resumeTasks.isEmpty)
        XCTAssertEqual(payload.accounts.first?.windows.first?.remainingPercent, 70)
        XCTAssertEqual(payload.accounts.first?.windows.first?.observedAtMs, 900)
        XCTAssertEqual(payload.accounts.first?.windows.first?.freshness, "stale")
        XCTAssertFalse(payload.accounts.first?.collection.isHealthy == true)
        let model = PopoverModel()
        model.applyCachedQuota(payload)
        XCTAssertTrue(model.showingStartupCache)
        XCTAssertFalse(model.canActOnTasks)
        XCTAssertFalse(model.detailsLoaded)
        XCTAssertEqual(try XCTUnwrap(model.measurementDate).timeIntervalSince1970, 0.9, accuracy: 0.00001)
        model.applyQuota(try status(time: 2000))
        XCTAssertFalse(model.showingStartupCache)
        XCTAssertTrue(model.canActOnTasks)
        XCTAssertFalse(model.detailsLoaded)
        let permissions = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(permissions?.intValue, 0o600)
        XCTAssertNil(QuotaSnapshotCache(endpoint: "http://127.0.0.1:2", url: file).load())
        XCTAssertNil(cache.load(now: Date(timeIntervalSince1970: -100)))
    }

    func testCacheIgnoresInjectedAuthorityAndReassertsStaleEvenForModifiedFile() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("quota.json")
        let cache = QuotaSnapshotCache(endpoint: "http://127.0.0.1:1", url: file)
        try cache.save(status())
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        object["actionToken"] = "must-not-load"
        object["autoResume"] = ["accounts": [], "incidents": []]
        var accounts = try XCTUnwrap(object["accounts"] as? [[String: Any]])
        accounts[0]["collection"] = ["health": "recent-success"]
        object["accounts"] = accounts
        try JSONSerialization.data(withJSONObject: object).write(to: file)
        let saved = try XCTUnwrap(cache.load())
        XCTAssertNil(saved.actionToken)
        XCTAssertNil(saved.autoResume)
        XCTAssertEqual(saved.accounts[0].collection.health, "stale-success")
    }

    func testStartupCachePreservesUnavailableQuotaAccessAndRemovesHistoricalAllowanceOnSaveAndLoad() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("quota.json")
        let cache = QuotaSnapshotCache(endpoint: "http://127.0.0.1:1", url: file)
        for category in ["claude-code-unavailable", "access-denied"] {
            let oldWindow: [String: Any] = ["provider": "claude", "account": "fixture", "bucket": "five_hour",
                "label": "5h", "windowSeconds": 18000, "freshness": "fresh", "observedAtMs": 900, "remainingPercent": 98]
            let account: [String: Any] = ["provider": "claude", "account": "fixture", "accountLabel": "Fixture", "enabled": true,
                "collection": ["health": "attempted-then-failed", "errorCategory": category, "errorDetail": "private-error"],
                "windows": [oldWindow], "bottleneckBucket": "five_hour", "updatedAtMs": 900]
            let live = try JSONDecoder().decode(StatusPayload.self, from: JSONSerialization.data(withJSONObject:
                ["nowMs": 1000, "accounts": [account]]))
            try cache.save(live)
            let onDisk = try JSONDecoder().decode(StatusPayload.self, from: Data(contentsOf: file))
            XCTAssertEqual(onDisk.accounts[0].collection.errorCategory, category)
            XCTAssertTrue(onDisk.accounts[0].windows.isEmpty)
            XCTAssertNil(onDisk.accounts[0].bottleneckBucket)
            XCTAssertNil(onDisk.accounts[0].updatedAtMs)
            XCTAssertNil(onDisk.accounts[0].collection.errorDetail)
            XCTAssertEqual(live.accounts[0].windows.count, 1, "Saving a display cache leaves the live observation unchanged")

            // A cache from an older client may still contain historical windows;
            // reading must enforce the same projection independently of saving.
            var object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
            var historical = account
            historical["collection"] = ["health": "recent-success", "errorCategory": category]
            object["accounts"] = [historical]
            try JSONSerialization.data(withJSONObject: object).write(to: file)
            let loaded = try XCTUnwrap(cache.load())
            let restored = try XCTUnwrap(loaded.accounts.first)
            XCTAssertEqual(restored.collection.errorCategory, category)
            XCTAssertFalse(restored.collection.isHealthy)
            XCTAssertNotNil(restored.collection.accessExplanation)
            XCTAssertNil(restored.collection.recoveryCommand)
            XCTAssertTrue(restored.windows.isEmpty)
            XCTAssertNil(restored.bottleneckBucket)
            XCTAssertNil(restored.updatedAtMs)
            XCTAssertNil(restored.overviewWindow)
        }
    }

    func testUnavailableCodeConnectionDoesNotLabelHistoricalSuccessAsCurrentMeasurement() throws {
        let model = PopoverModel()
        for category in ["claude-code-unavailable", "access-denied"] {
            let payload = try JSONDecoder().decode(StatusPayload.self, from: JSONSerialization.data(withJSONObject: [
                "accounts": [["provider": "claude", "account": "fixture", "accountLabel": "Fixture", "enabled": true,
                    "collection": ["health": "attempted-then-failed", "errorCategory": category, "lastSuccessAtMs": 1000],
                    "windows": []]],
            ]))
            model.applyQuota(payload)
            model.showAccount(try XCTUnwrap(model.payload?.accounts.first))
            XCTAssertNil(model.measurementDate)
            XCTAssertNil(model.displayedMeasurementDate)
        }
    }

    func testSupersededQuotaCallbackCannotFinishTheReplacementRequest() throws {
        let gate = QuotaRequestGate()
        let first = try XCTUnwrap(gate.begin())
        XCTAssertNil(gate.begin())
        gate.cancel()
        let replacement = try XCTUnwrap(gate.begin())
        XCTAssertFalse(gate.finish(first))
        XCTAssertNil(gate.begin(), "An old callback must not clear the new request's in-flight state")
        XCTAssertTrue(gate.finish(replacement))
        XCTAssertFalse(gate.finish(replacement), "A duplicate completion is ignored")
        XCTAssertNotNil(gate.begin())
    }

    func testWakeReplacementReadsImmediatelyWhileTheCancelledHTTPResponseIsDelayed() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let started = directory.appendingPathComponent("first-started")
        let server = Process()
        server.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        server.arguments = ["-u", "-c", """
        import http.server, json, pathlib, sys, time
        count = 0
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                global count
                count += 1
                current = count
                if current == 1:
                    pathlib.Path(sys.argv[1]).write_text('started')
                    time.sleep(5)
                payload = json.dumps({'nowMs':current*1000,'accounts':[]}).encode()
                try:
                    self.send_response(200)
                    self.send_header('Content-Length',str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                except BrokenPipeError: pass
            def log_message(self,*args): pass
        server = http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
        print(server.server_port,flush=True)
        server.serve_forever()
        """, started.path]
        let output = Pipe()
        server.standardOutput = output
        server.standardError = FileHandle.nullDevice
        try server.run()
        defer { if server.isRunning { server.terminate(); server.waitUntilExit() } }
        let port = try XCTUnwrap(String(data: output.fileHandleForReading.availableData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines))
        let client = try StatusClient(environment:["QUOTAPIE_API_URL":"http://127.0.0.1:\(port)"])
        let gate = QuotaRequestGate()
        let first = try XCTUnwrap(gate.begin())
        let cancelled = expectation(description:"cancelled callback ignored")
        gate.attach(client.fetchQuota { result in
            DispatchQueue.main.async {
                XCTAssertFalse(gate.finish(first))
                if case .failure(let error) = result { XCTAssertEqual((error as? URLError)?.code, .cancelled) }
                else { XCTFail("Expected cancellation") }
                cancelled.fulfill()
            }
        },generation:first)
        let serverStarted = XCTNSPredicateExpectation(predicate:NSPredicate { _,_ in
            FileManager.default.fileExists(atPath:started.path)
        },object:nil)
        wait(for:[serverStarted],timeout:3)
        gate.cancel()
        let second = try XCTUnwrap(gate.begin())
        let fresh = expectation(description:"replacement read")
        let start = Date()
        gate.attach(client.fetchQuota { result in
            DispatchQueue.main.async {
                XCTAssertTrue(gate.finish(second))
                switch result {
                case .success(let payload): XCTAssertEqual(payload.nowMs,2000)
                case .failure(let error): XCTFail(error.localizedDescription)
                }
                XCTAssertLessThan(Date().timeIntervalSince(start),3)
                fresh.fulfill()
            }
        },generation:second)
        wait(for:[cancelled,fresh],timeout:3)
    }

    func testFastReadAndRefreshUseSeparateAuthenticatedEndpoints() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let capture = directory.appendingPathComponent("requests.json")
        let server = Process()
        server.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        server.arguments = ["-u", "-c", """
        import http.server, json, pathlib, sys
        requests = []
        class Handler(http.server.BaseHTTPRequestHandler):
            def reply(self, status):
                body = self.rfile.read(int(self.headers.get('content-length','0')))
                requests.append({'path':self.path,'method':self.command,'token':self.headers.get('x-quotapie-action-token'),'body':json.loads(body) if body else None})
                pathlib.Path(sys.argv[1]).write_text(json.dumps(requests))
                payload = b'{"nowMs":1000,"accounts":[],"actionToken":"fixture-token","collection":{"refreshing":true}}'
                self.send_response(status)
                self.send_header('Content-Length',str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            def do_GET(self): self.reply(200)
            def do_POST(self): self.reply(202)
            def log_message(self,*args): pass
        server = http.server.HTTPServer(('127.0.0.1',0),Handler)
        print(server.server_port,flush=True)
        server.serve_forever()
        """, capture.path]
        let output = Pipe()
        server.standardOutput = output
        server.standardError = FileHandle.nullDevice
        try server.run()
        defer { if server.isRunning { server.terminate(); server.waitUntilExit() } }
        let port = try XCTUnwrap(String(data: output.fileHandleForReading.availableData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines))
        let client = try StatusClient(environment: ["QUOTAPIE_API_URL": "http://127.0.0.1:\(port)"])
        let read = expectation(description: "fast quota")
        client.fetchQuota { result in
            switch result {
            case .success(let payload): XCTAssertTrue(payload.collection?.refreshing == true)
            case .failure(let error): XCTFail(error.localizedDescription)
            }
            read.fulfill()
        }
        wait(for: [read], timeout: 5)
        for reason in ["startup", "wake", "network", "manual", "visible"] {
            let refreshed = expectation(description: reason)
            client.refreshCollection(reason: reason, actionToken: "fixture-token") { result in
                switch result {
                case .success(let collection): XCTAssertTrue(collection.refreshing)
                case .failure(let error): XCTFail(error.localizedDescription)
                }
                refreshed.fulfill()
            }
            wait(for: [refreshed], timeout: 5)
        }
        let requests = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: capture)) as? [[String: Any]])
        XCTAssertEqual(requests.count, 6)
        XCTAssertEqual(requests[0]["path"] as? String, "/api/quota")
        XCTAssertEqual(requests[0]["method"] as? String, "GET")
        XCTAssertTrue(requests[0]["token"] is NSNull)
        for (index, reason) in ["startup", "wake", "network", "manual", "visible"].enumerated() {
            XCTAssertEqual(requests[index + 1]["path"] as? String, "/api/collection/refresh")
            XCTAssertEqual(requests[index + 1]["method"] as? String, "POST")
            XCTAssertEqual(requests[index + 1]["token"] as? String, "fixture-token")
            XCTAssertEqual(requests[index + 1]["body"] as? [String: String], ["reason": reason])
        }
    }
}
