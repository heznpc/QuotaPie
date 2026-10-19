import Foundation

/// Main-thread ownership for this app's single quota HTTP read. Wake/reconnect
/// replaces only that request; a cancelled response cannot alter current UI.
final class QuotaRequestGate {
    private var generation = 0
    private var inFlight = false
    private var task: URLSessionDataTask?

    func begin() -> Int? {
        guard !inFlight else { return nil }
        generation += 1
        inFlight = true
        return generation
    }

    func attach(_ task: URLSessionDataTask, generation requestGeneration: Int) {
        guard inFlight, generation == requestGeneration else { task.cancel(); return }
        self.task = task
    }

    func finish(_ requestGeneration: Int) -> Bool {
        guard inFlight, generation == requestGeneration else { return false }
        task = nil
        inFlight = false
        return true
    }

    func cancel() {
        generation += 1
        inFlight = false
        let previous = task
        task = nil
        previous?.cancel()
    }
}
