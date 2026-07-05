import Cocoa

// Fn-suppression event tap: OVER-BROAD variant (Run C regression). The
// callback swallows every `.flagsChanged` event tap-wide instead of scoping
// suppression to the Fn keycode, so holding any modifier key (Shift, Control,
// Command) silently eats the event system-wide.
final class OverbroadFnSuppressionTap {
    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?

    func install() {
        let eventMask = (1 << CGEventType.flagsChanged.rawValue)

        eventTap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: CGEventMask(eventMask),
            callback: { _, type, event, _ in
                guard type == .flagsChanged else {
                    return Unmanaged.passUnretained(event)
                }
                // BUG: returns nil for every flagsChanged event, not just the
                // Fn key. This suppresses Shift/Control/Command/Option too.
                return nil
            },
            userInfo: nil
        )

        guard let eventTap else {
            fatalError("failed to create event tap")
        }

        runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, eventTap, 0)
        CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
        CGEvent.tapEnable(tap: eventTap, enable: true)
    }
}
