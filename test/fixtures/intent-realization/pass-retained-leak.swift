import Cocoa

// Fn-suppression event tap callback with a retain-count leak. Every
// non-suppressed path calls `Unmanaged.passRetained(event)` to hand the event
// back to the system, but nothing on this file's paths ever calls
// `.release()` on the returned `Unmanaged` wrapper, so the retained CGEvent is
// never balanced with a matching release.
final class LeakyFnSuppressionTap {
    private var eventTap: CFMachPort?

    func install() {
        let eventMask = (1 << CGEventType.flagsChanged.rawValue)

        eventTap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: CGEventMask(eventMask),
            callback: { _, type, event, _ in
                guard type == .flagsChanged,
                      let nsEvent = NSEvent(cgEvent: event),
                      nsEvent.keyCode == kVK_Function
                else {
                    // LEAK: passRetained bumps the retain count on `event`,
                    // but the caller never balances it with `.release()`.
                    return Unmanaged.passRetained(event)
                }
                return nil
            },
            userInfo: nil
        )

        guard let eventTap else {
            fatalError("failed to create event tap")
        }

        let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, eventTap, 0)
        CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
        CGEvent.tapEnable(tap: eventTap, enable: true)
    }
}
