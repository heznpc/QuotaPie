import SwiftUI

struct AutomaticWorkView: View {
    @ObservedObject var model: PopoverModel
    @State private var data: AutomaticWorkResponse?
    @State private var draft: AutomaticWorkPolicy?
    @State private var targets: [AutomaticWorkTarget] = []
    @State private var busy = false
    @State private var error: String?
    @State private var client: StatusClient?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(Strings.t("automatic.title")).font(.headline)
                Spacer()
                Button(Strings.t("action.refresh"), action: refresh).disabled(busy)
            }
            Text(Strings.t("automatic.description")).font(.callout).foregroundStyle(.secondary)
            if let error { Text(error).foregroundStyle(.red).font(.caption) }
            if busy { ProgressView().controlSize(.small) }
            if let data {
                ForEach(data.policies) { policy in
                    policyRow(policy)
                }
                if data.policies.isEmpty { Text(Strings.t("automatic.empty")).foregroundStyle(.secondary) }
                if draft == nil {
                    Button(Strings.t("automatic.create")) {
                        guard let account = data.accounts.first else { return }
                        draft = .draft(provider: account.provider, account: account.account, buckets: account.buckets, reserveByBucket: account.reserveByBucket)
                        targets = []
                    }.disabled(data.accounts.isEmpty || busy)
                }
                if let current = draft {
                    AutomaticWorkEditor(policy: Binding(get: { draft ?? current }, set: { draft = $0 }),
                                        accounts: data.accounts, targets: targets, defaultTimeZone: data.defaults.timeZone,
                                        browse: browse, save: save, cancel: { draft = nil; targets = [] })
                        .disabled(busy)
                }
                if !data.executions.isEmpty {
                    DisclosureGroup(Strings.t("automatic.executions")) {
                        ForEach(data.executions.prefix(20)) { execution in
                            VStack(alignment: .leading, spacing: 4) {
                                let name = data.policies.first { $0.id == execution.policyId }?.objective ?? execution.policyId
                                Text(name).font(.callout).lineLimit(2)
                                Text("\(execution.owner == "dots" ? "Dots" : Strings.t("automatic.local")) · \(Strings.t("automatic.status." + (execution.result?.status ?? execution.status)))")
                                    .font(.caption).foregroundStyle(.secondary)
                                Text(Date(timeIntervalSince1970: execution.claimedAtMs / 1000), style: .date).font(.caption)
                                if let detail = execution.result?.report ?? execution.result?.summary ?? execution.result?.reason {
                                    Text(detail).font(.caption).textSelection(.enabled)
                                }
                                if let remaining = execution.result?.remainingWork { Text(remaining).font(.caption) }
                                if let question = execution.result?.blockingQuestion { Text(question).font(.caption).foregroundStyle(.orange) }
                                Divider()
                            }.padding(.vertical, 4)
                        }
                    }
                }
            }
        }
        .disabled(!model.canActOnTasks)
        .onAppear { if data == nil { refresh() } }
        .onChange(of: model.canActOnTasks) { available in if available && data == nil { refresh() } }
        .onChange(of: draft.map { $0.provider + "/" + $0.account }) { _ in targets = [] }
    }

    private func policyRow(_ policy: AutomaticWorkPolicy) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(policy.objective).font(.callout).lineLimit(2)
                Spacer()
                Button(Strings.t("automatic.edit")) { draft = policy; targets = [] }.disabled(busy || draft != nil)
                Button(Strings.t(policy.enabled ? "automatic.disable" : "automatic.enable")) { toggle(policy) }.disabled(busy || draft != nil)
            }
            Text("\(policy.provider) · \(policy.account) · \(policy.dispatchOwner == "dots" ? "Dots" : Strings.t("automatic.local"))")
                .font(.caption).foregroundStyle(.secondary)
            if let admission = policy.admission, !admission.ready {
                Label(AutomaticWorkReason.text(admission.reason), systemImage: "pause.circle")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let state = policy.state {
                Text(Strings.t("automatic.status." + state.status)).font(.caption)
                if policy.performance == nil {
                    ForEach(state.spentByBucket.keys.sorted(), id: \.self) { bucket in
                        Text(Strings.t("automatic.spent", bucket, String(format: "%.1f", state.spentByBucket[bucket] ?? 0)))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            if let performance = policy.performance {
                DisclosureGroup(Strings.t("automatic.performance")) {
                    VStack(alignment: .leading, spacing: 5) {
                        ForEach(performance.buckets.keys.sorted(), id: \.self) { bucket in
                            if let result = performance.buckets[bucket] {
                                Text(Strings.t("automatic.accountUsage", bucket, String(format: "%.1f", result.accountUsage)))
                                if let target = result.targetUsagePercent {
                                    Text(Strings.t("automatic.targetResult", String(format: "%.1f", target),
                                                   Strings.t("automatic.target." + result.targetMet)))
                                } else { Text(Strings.t("automatic.target.not-configured")) }
                                if let beforeReset = result.beforeResetAccountUsage {
                                    Text(Strings.t("automatic.beforeResetUsage", String(format: "%.1f", beforeReset)))
                                    if let targetMet = result.beforeResetTargetMet {
                                        Text(Strings.t("automatic.beforeResetTarget", Strings.t("automatic.target." + targetMet)))
                                    }
                                } else { Text(Strings.t("automatic.beforeResetUnmeasured")).foregroundStyle(.secondary) }
                            }
                        }
                        Text(Strings.t(performance.usefulWorkCompleted ? "automatic.usefulCompleted" : "automatic.usefulUnconfirmed"))
                        if performance.completionAssessment == "model-assessed" { Text(Strings.t("automatic.modelAssessed")) }
                        Text(Strings.t(performance.limitsRespected ? "automatic.limitsRespected" : "automatic.limitsExceeded"))
                        Text(Strings.t("automatic.observedOnly")).foregroundStyle(.secondary)
                        if !performance.attributionAvailable { Text(Strings.t("automatic.unattributed")).foregroundStyle(.secondary) }
                    }.font(.caption).padding(.top, 4)
                }
            }
            Divider()
        }
    }

    private func request(_ action: (StatusClient, String) -> Void) {
        guard !busy, model.canActOnTasks, let token = model.payload?.actionToken else { return }
        guard let service = model.statusClient else { error = Strings.t("client.badResponse"); return }
        client = service; busy = true; error = nil; action(service, token)
    }
    private func refresh() {
        request { service, token in
            service.automaticWork(actionToken: token) { result in
                DispatchQueue.main.async {
                    busy = false; client = nil
                    switch result { case .success(let value): data = value; model.automaticWorkLoadedPolicyIDs = value.policies.map(\.id)
                    case .failure(let failure): error = failure.localizedDescription }
                }
            }
        }
    }
    private func browse() {
        guard let policy = draft else { return }
        request { service, token in
            service.automaticWorkTargets(provider: policy.provider, account: policy.account, actionToken: token) { result in
                DispatchQueue.main.async {
                    busy = false; client = nil
                    guard draft?.provider == policy.provider, draft?.account == policy.account else { return }
                    switch result { case .success(let value): targets = value.targets
                    case .failure(let failure): error = failure.localizedDescription }
                }
            }
        }
    }
    private func saved(_ result: Result<AutomaticWorkSaveResponse, Error>) {
        DispatchQueue.main.async {
            busy = false; client = nil
            switch result {
            case .success: draft = nil; targets = []; refresh()
            case .failure(let failure): error = failure.localizedDescription
            }
        }
    }
    private func save() {
        guard let policy = draft else { return }
        request { service, token in service.saveAutomaticWork(policy, actionToken: token, completion: saved) }
    }
    private func toggle(_ policy: AutomaticWorkPolicy) {
        guard let revision = policy.revision else { return }
        request { service, token in
            service.enableAutomaticWork(id: policy.id, enabled: !policy.enabled, revision: revision, actionToken: token, completion: saved)
        }
    }
}

private struct AutomaticWorkEditor: View {
    @Binding var policy: AutomaticWorkPolicy
    let accounts: [AutomaticWorkAccount]
    let targets: [AutomaticWorkTarget]
    let defaultTimeZone: String
    let browse: () -> Void
    let save: () -> Void
    let cancel: () -> Void
    @State private var newBucket = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(Strings.t("automatic.configuration")).font(.headline)
            Picker(Strings.t("automatic.account"), selection: accountBinding) {
                ForEach(accounts) { account in Text("\(account.provider) · \(account.label)").tag(account.id) }
            }.disabled(policy.revision != nil)
            HStack {
                field("automatic.session", text: $policy.nativeSessionId)
                Button(Strings.t("automatic.browse"), action: browse)
            }.disabled(policy.revision != nil)
            if !targets.isEmpty, policy.revision == nil {
                Picker(Strings.t("automatic.sessions"), selection: $policy.nativeSessionId) {
                    Text(Strings.t("automatic.choose")).tag("")
                    ForEach(targets) { target in Text(target.title).tag(target.nativeSessionId) }
                }
            }
            Picker(Strings.t("automatic.executor"), selection: $policy.dispatchOwner) {
                Text(Strings.t("automatic.local")).tag("local")
                Text("Dots").tag("dots")
            }
            field("automatic.objective", text: $policy.objective)
            Text(Strings.t("automatic.prompt")).font(.caption)
            TextEditor(text: $policy.prompt).frame(minHeight: 65).border(Color.secondary.opacity(0.3))
            Text(Strings.t("automatic.criteria")).font(.caption)
            TextEditor(text: Binding(get: { policy.completionCriteria.joined(separator: "\n") },
                                     set: { policy.completionCriteria = $0.components(separatedBy: "\n") }))
                .frame(minHeight: 55).border(Color.secondary.opacity(0.3))
            Picker(Strings.t("automatic.trigger"), selection: $policy.trigger) {
                Text(Strings.t("automatic.trigger.quota-ready")).tag("quota-ready")
                Text(Strings.t("automatic.trigger.public-announcement")).tag("public-announcement")
                Text(Strings.t("automatic.trigger.scheduled")).tag("scheduled")
            }
            Picker(Strings.t("automatic.resetBucket"), selection: Binding(get: { policy.resetBucket ?? "" }, set: { policy.resetBucket = $0.isEmpty ? nil : $0 })) {
                Text(Strings.t("automatic.anyBucket")).tag("")
                ForEach(policy.budgetByBucket.keys.sorted(), id: \.self) { Text($0).tag($0) }
            }
            if policy.trigger == "scheduled" {
                number("automatic.lead", value: $policy.resetWithinMinutes)
            }
            budgetFields
            DisclosureGroup(Strings.t("automatic.advanced")) { advancedFields.padding(.top, 8) }
            Toggle(Strings.t("automatic.enableOnSave"), isOn: $policy.enabled)
            HStack {
                Button(Strings.t("automatic.save"), action: save).disabled(!valid)
                Button(Strings.t("automatic.cancel"), action: cancel)
            }
        }.padding(10).background(Color.primary.opacity(0.03)).cornerRadius(8)
    }

    private var budgetFields: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(Strings.t("automatic.budgets")).font(.subheadline)
            Text(Strings.t("automatic.budgetExplanation")).font(.caption).foregroundStyle(.secondary)
            ForEach(policy.budgetByBucket.keys.sorted(), id: \.self) { bucket in
                VStack(alignment: .leading, spacing: 5) {
                    HStack { Text(bucket).font(.caption); Spacer(); Button(Strings.t("automatic.remove")) { policy.budgetByBucket.removeValue(forKey: bucket) } }
                    number("automatic.reserve", value: budgetBinding(bucket, \.reservePercent))
                    number("automatic.maximum", value: budgetBinding(bucket, \.maxUsagePercent))
                    Toggle(Strings.t("automatic.targetEnabled"), isOn: Binding(get: { policy.budgetByBucket[bucket]?.targetUsagePercent != nil }, set: { policy.budgetByBucket[bucket]?.targetUsagePercent = $0 ? 10 : nil }))
                    if policy.budgetByBucket[bucket]?.targetUsagePercent != nil {
                        number("automatic.target", value: Binding(get: { policy.budgetByBucket[bucket]?.targetUsagePercent ?? 0 }, set: { policy.budgetByBucket[bucket]?.targetUsagePercent = $0 }))
                    }
                }
            }
            HStack {
                TextField(Strings.t("automatic.bucketID"), text: $newBucket)
                Button(Strings.t("automatic.addBucket")) {
                    let key = newBucket.trimmingCharacters(in: .whitespaces)
                    if !key.isEmpty, policy.budgetByBucket[key] == nil { policy.budgetByBucket[key] = AutomaticWorkBudget(reservePercent: accounts.first { $0.provider == policy.provider && $0.account == policy.account }?.reserveByBucket[key] ?? 0, maxUsagePercent: 20) }
                    newBucket = ""
                }.disabled(newBucket.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }

    private var advancedFields: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(Strings.t("automatic.originalModel", policy.model ?? Strings.t("automatic.sessionDefault"))).font(.caption).foregroundStyle(.secondary)
            HStack { Text(Strings.t("automatic.turns")); Spacer(); TextField("", value: $policy.maxTurns, format: .number).frame(width: 90) }
            number("automatic.turnSeconds", value: $policy.maxDurationSeconds)
            number("automatic.totalSeconds", value: $policy.maxTotalDurationSeconds)
            number("automatic.priority", value: $policy.priority)
            DatePicker(Strings.t("automatic.expires"), selection: dateBinding(\.expiresAtMs))
            Toggle(Strings.t("automatic.deadlineEnabled"), isOn: Binding(get: { policy.workDeadline != nil }, set: { policy.workDeadline = $0 ? policy.expiresAtMs : nil }))
            if policy.workDeadline != nil {
                DatePicker(Strings.t("automatic.deadline"), selection: Binding(get: { Date(timeIntervalSince1970: (policy.workDeadline ?? policy.expiresAtMs) / 1000) }, set: { policy.workDeadline = $0.timeIntervalSince1970 * 1000 }))
            }
            Picker(Strings.t("automatic.onReset"), selection: $policy.onReset) {
                Text(Strings.t("automatic.resetStop")).tag("stop")
                Text(Strings.t("automatic.resetContinue")).tag("continue")
            }
            Toggle(Strings.t("automatic.scheduleEnabled"), isOn: Binding(get: { policy.activitySchedule != nil }, set: { policy.activitySchedule = $0 ? AutomaticWorkSchedule(timeZone: defaultTimeZone, days: [1,2,3,4,5], start: "09:00", end: "18:00") : nil }))
            if policy.activitySchedule != nil {
                field("automatic.timeZone", text: scheduleBinding(\.timeZone))
                field("automatic.start", text: scheduleBinding(\.start))
                field("automatic.end", text: scheduleBinding(\.end))
                ForEach(0..<7) { day in
                    Toggle(Strings.t("automatic.day.\(day)"), isOn: Binding(get: { policy.activitySchedule?.days.contains(day) ?? false }, set: { enabled in
                        var days = policy.activitySchedule?.days ?? []
                        days.removeAll { $0 == day }; if enabled { days.append(day) }
                        policy.activitySchedule?.days = days.sorted()
                    }))
                }
            }
        }
    }
    private var valid: Bool {
        !policy.nativeSessionId.isEmpty && !policy.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !policy.objective.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        policy.completionCriteria.contains { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } &&
        (policy.trigger != "scheduled" || policy.resetBucket != nil) && !policy.budgetByBucket.isEmpty && policy.maxTurns > 0 && policy.maxDurationSeconds > 0 && policy.maxTotalDurationSeconds > 0 &&
        policy.budgetByBucket.values.allSatisfy { budget in (0...100).contains(budget.reservePercent) && (0...100).contains(budget.maxUsagePercent) && (budget.targetUsagePercent.map { (0...budget.maxUsagePercent).contains($0) } ?? true) }
    }
    private var accountBinding: Binding<String> {
        Binding(get: { policy.provider + "/" + policy.account }, set: { id in
            guard let account = accounts.first(where: { $0.id == id }) else { return }
            policy.provider = account.provider; policy.account = account.account; policy.nativeSessionId = ""
            policy.budgetByBucket = Dictionary(uniqueKeysWithValues: account.buckets.map { ($0, AutomaticWorkBudget(reservePercent: account.reserveByBucket[$0] ?? 0, maxUsagePercent: 20)) })
            policy.resetBucket = nil
        })
    }
    private func budgetBinding(_ bucket: String, _ key: WritableKeyPath<AutomaticWorkBudget, Double>) -> Binding<Double> {
        Binding(get: { policy.budgetByBucket[bucket]?[keyPath: key] ?? 0 }, set: { policy.budgetByBucket[bucket]?[keyPath: key] = $0 })
    }
    private func scheduleBinding(_ key: WritableKeyPath<AutomaticWorkSchedule, String>) -> Binding<String> {
        Binding(get: { policy.activitySchedule?[keyPath: key] ?? "" }, set: { policy.activitySchedule?[keyPath: key] = $0 })
    }
    private func dateBinding(_ key: WritableKeyPath<AutomaticWorkPolicy, Double>) -> Binding<Date> {
        Binding(get: { Date(timeIntervalSince1970: policy[keyPath: key] / 1000) }, set: { policy[keyPath: key] = $0.timeIntervalSince1970 * 1000 })
    }
    private func field(_ key: String, text: Binding<String>) -> some View { TextField(Strings.t(key), text: text) }
    private func number(_ key: String, value: Binding<Double>) -> some View {
        HStack { Text(Strings.t(key)); Spacer(); TextField("", value: value, format: .number).frame(width: 90) }
    }
}
