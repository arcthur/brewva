import Cocoa

// Fn-suppression event tap: CORRECT variant. Suppression is scoped to the Fn
// keycode only, and callback ownership uses `passUnretained` (the callback
// does not take ownership of `event`, so no matching release is owed).
//
// NOTE for the trap library's precision guard: this file still contains
// `CGEvent.tapCreate`, so the write/verify file-input trap (seed entry 2)
// FIRES on this fixture too. That is correct: a trap surfaces a lens
// ("look here with this stance"), it does not assert a defect. The
// human/reviewer reads this file under the "verify suppression is
// keycode-scoped and callback ownership uses passUnretained" lens and
// confirms it holds.
final class CorrectFnSuppressionTap {
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
                    // Every other flagsChanged event (Shift/Control/Command/
                    // Option) passes through untouched, un-owned.
                    return Unmanaged.passUnretained(event)
                }
                // Only the Fn key is suppressed.
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
