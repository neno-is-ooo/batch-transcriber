use std::process::Command;

const CHECK_PERMISSION_SCRIPT: &str = r#"
import Dispatch
import UserNotifications

let semaphore = DispatchSemaphore(value: 0)
var granted = false

UNUserNotificationCenter.current().getNotificationSettings { settings in
    switch settings.authorizationStatus {
    case .authorized, .provisional, .ephemeral:
        granted = true
    default:
        granted = false
    }
    semaphore.signal()
}

_ = semaphore.wait(timeout: .now() + 2)
print(granted ? "granted" : "denied")
"#;

const REQUEST_PERMISSION_SCRIPT: &str = r#"
import Dispatch
import UserNotifications

let semaphore = DispatchSemaphore(value: 0)
var granted = false

UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { ok, _ in
    granted = ok
    semaphore.signal()
}

_ = semaphore.wait(timeout: .now() + 5)
print(granted ? "granted" : "denied")
"#;

fn parse_permission_output(output: &[u8]) -> bool {
    String::from_utf8_lossy(output)
        .trim()
        .eq_ignore_ascii_case("granted")
}

#[cfg(target_os = "macos")]
fn run_swift_permission_script(script: &str) -> bool {
    let output = Command::new("/usr/bin/swift")
        .arg("-e")
        .arg(script)
        .output();
    match output {
        Ok(result) if result.status.success() => parse_permission_output(&result.stdout),
        _ => false,
    }
}

pub fn check_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        return run_swift_permission_script(CHECK_PERMISSION_SCRIPT);
    }

    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

pub fn request_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        return run_swift_permission_script(REQUEST_PERMISSION_SCRIPT);
    }

    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

#[cfg(target_os = "macos")]
fn escape_applescript(input: &str) -> String {
    input
        .replace('\\', "\\\\")
        .replace('\"', "\\\"")
        .replace('\n', " ")
}

pub fn send(title: &str, body: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "display notification \"{}\" with title \"{}\"",
            escape_applescript(body),
            escape_applescript(title)
        );

        return Command::new("/usr/bin/osascript")
            .arg("-e")
            .arg(script)
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (title, body);
        false
    }
}

#[cfg(test)]
mod tests {
    use super::parse_permission_output;

    #[test]
    fn parses_granted_permission_output() {
        assert!(parse_permission_output(b"granted\n"));
        assert!(parse_permission_output(b"GRANTED"));
    }

    #[test]
    fn parses_denied_permission_output() {
        assert!(!parse_permission_output(b"denied"));
        assert!(!parse_permission_output(b""));
    }
}
