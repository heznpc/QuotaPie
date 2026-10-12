import SwiftUI

struct DotsConnectionStatus: Decodable {
    let state: String
    let toolAvailable: Bool
    let configured: Bool
    let processRunning: Bool
    let healthy: Bool
    let ready: Bool
    let discoveryObserved: Bool
    let activeSubscriptions: Int
    let enabledTargets: Int
    let nextURL: String?
    let canConnect: Bool
    let canDisconnect: Bool

    var approvalURL: URL? {
        guard let nextURL, ["https://platform.openai.com/settings/organization/tunnels", "https://chatgpt.com/plugins"].contains(nextURL) else { return nil }
        return URL(string: nextURL)
    }
}

struct DotsConnectionView: View {
    @ObservedObject var model: PopoverModel
    @State private var connection: DotsConnectionStatus?
    @State private var busy = false
    @State private var failed = false
    @State private var client: StatusClient?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(Strings.t("dots.title")).font(.headline)
            Text(Strings.t("dots.description")).font(.callout).foregroundStyle(.secondary)
            if let connection {
                Text(Strings.t("dots.state." + connection.state)).font(.callout)
                VStack(alignment: .leading, spacing: 5) {
                    step("dots.tool", verified: connection.toolAvailable)
                    step("dots.transport", verified: connection.ready)
                    step("dots.discovery", verified: connection.ready && connection.discoveryObserved)
                    step("dots.subscription", verified: connection.ready && connection.activeSubscriptions > 0)
                }.font(.caption)
                Text(Strings.t("dots.targets", String(connection.enabledTargets)))
                    .font(.caption).foregroundStyle(.secondary)
                Text(Strings.t("dots.verificationBoundary")).font(.caption).foregroundStyle(.secondary)
                HStack {
                    if connection.canConnect && !connection.processRunning {
                        Button(Strings.t("dots.connect")) { request("connect") }
                    }
                    if let url = connection.approvalURL {
                        Link(Strings.t(connection.state == "plugin-required" ? "dots.plugin" : "dots.authorize"), destination: url)
                    }
                    if connection.canDisconnect || (connection.configured && connection.state == "account-mismatch") {
                        Button(Strings.t("dots.disconnect")) { request("disconnect") }
                    }
                    Button(Strings.t("action.refresh")) { request() }
                }
            } else if !busy {
                Button(Strings.t("dots.inspect")) { request() }
            }
            if busy { ProgressView().controlSize(.small) }
            if failed { Text(Strings.t("dots.error")).font(.caption).foregroundStyle(.secondary) }
        }
        .disabled(busy || !model.canActOnTasks)
        .onAppear { if connection == nil { request() } }
    }

    private func step(_ key: String, verified: Bool) -> some View {
        Label(Strings.t(key), systemImage: verified ? "checkmark.circle.fill" : "circle")
            .foregroundStyle(verified ? Color.primary : Color.secondary)
    }

    private func request(_ action: String? = nil) {
        guard !busy, model.canActOnTasks, let token = model.payload?.actionToken else { return }
        busy = true; failed = false
        do {
            let service = try StatusClient(operationTimeout: 50)
            client = service
            service.dotsConnection(action: action, actionToken: token) { result in
                DispatchQueue.main.async {
                    busy = false; client = nil
                    switch result {
                    case .success(let status): connection = status
                    case .failure: failed = true; connection = nil
                    }
                }
            }
        } catch { busy = false; failed = true; connection = nil }
    }
}
