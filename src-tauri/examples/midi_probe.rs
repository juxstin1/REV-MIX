//! Standalone MIDI bring-up probe for the Launchpad Pro MK3.
//!
//! Run:  cargo run --example midi_probe            (enumerate only)
//!       cargo run --example midi_probe -- live     (enumerate + round-trip)
//!
//! This uses the EXACT backend the app ships (`midir`), so what it sees is the
//! ground truth for whether `lp_connect` can work on this machine. On Windows
//! `midir` is WinMM-only; if the device is bound to the new Windows MIDI
//! Services (MIDI 2.0/UMP) stack, it may not appear here even when plugged in.

use std::io::{stdin, stdout, Write};
use std::time::Duration;

use midir::{Ignore, MidiInput, MidiOutput};

const PROGRAMMER_ON: [u8; 8] = [0xF0, 0x00, 0x20, 0x29, 0x02, 0x0E, 0x0E, 0x01];
const PROGRAMMER_OFF: [u8; 8] = [0xF0, 0x00, 0x20, 0x29, 0x02, 0x0E, 0x0E, 0x00];

fn is_lp(name: &str) -> bool {
    let n = name.to_lowercase();
    n.contains("launchpad pro") || n.contains("lppromk3") || n.contains("lppro mk3")
}

fn main() {
    let live = std::env::args().any(|a| a == "live");

    let mo = MidiOutput::new("probe-out").expect("MidiOutput");
    let mut mi = MidiInput::new("probe-in").expect("MidiInput");
    mi.ignore(Ignore::None);

    println!("== midir OUTPUT ports ==");
    let out_ports = mo.ports();
    for (i, p) in out_ports.iter().enumerate() {
        let n = mo.port_name(p).unwrap_or_default();
        println!("  [{i}] {n}{}", if is_lp(&n) { "   <- LP candidate" } else { "" });
    }
    println!("== midir INPUT ports ==");
    let in_ports = mi.ports();
    for (i, p) in in_ports.iter().enumerate() {
        let n = mi.port_name(p).unwrap_or_default();
        println!("  [{i}] {n}{}", if is_lp(&n) { "   <- LP candidate" } else { "" });
    }

    let lp_out = out_ports.iter().find(|p| mo.port_name(p).map(|n| is_lp(&n)).unwrap_or(false));
    let lp_in = in_ports.iter().find(|p| mi.port_name(p).map(|n| is_lp(&n)).unwrap_or(false));

    println!();
    match (&lp_out, &lp_in) {
        (Some(_), Some(_)) => println!("RESULT: Launchpad visible to midir (in + out). midir backend will work."),
        (Some(_), None) => println!("RESULT: output found but NO input port. Input half will fail."),
        (None, Some(_)) => println!("RESULT: input found but NO output port. Output half will fail."),
        (None, None) => println!("RESULT: Launchpad NOT visible to midir. WinMM backend cannot reach it on this machine."),
    }

    if !live {
        println!("\n(enumerate-only; pass `-- live` to round-trip if a candidate was found)");
        return;
    }

    let (Some(op), Some(ip)) = (lp_out, lp_in) else {
        println!("\nNo round-trip: missing a candidate port.");
        return;
    };

    let out_name = mo.port_name(op).unwrap_or_default();
    println!("\nConnecting to: {out_name}");
    let mut out = mo.connect(op, "probe-lp-out").expect("connect out");
    out.send(&PROGRAMMER_ON).expect("programmer on");

    // Light pad 11 (lower-left) bright green via per-pad RGB SysEx.
    // F0 00 20 29 02 0E 03  03 <idx> <r> <g> <b>  F7
    let light = [0xF0, 0x00, 0x20, 0x29, 0x02, 0x0E, 0x03, 0x03, 11, 0, 127, 0, 0xF7];
    out.send(&light).expect("light pad");
    println!("Lit pad 11 (lower-left) green. Press pads/buttons — input prints below.");

    let _in = mi
        .connect(ip, "probe-lp-in", |_ts, msg, _| {
            // decode grid note → row/col for readability
            let tag = match msg.first().map(|b| b & 0xF0) {
                Some(0x90) if msg.len() >= 3 => {
                    let n = msg[1];
                    format!("note_on  num={n} (r{} c{}) vel={}", n / 10, n % 10, msg[2])
                }
                Some(0x80) => format!("note_off num={}", msg.get(1).copied().unwrap_or(0)),
                Some(0xB0) if msg.len() >= 3 => format!("cc       num={} val={}", msg[1], msg[2]),
                Some(0xA0) if msg.len() >= 3 => format!("aftertouch pad={} val={}", msg[1], msg[2]),
                Some(0xD0) => format!("pressure val={}", msg.get(1).copied().unwrap_or(0)),
                _ => format!("{msg:02X?}"),
            };
            println!("  IN  {tag}");
        }, ())
        .expect("connect in");

    println!("Listening 25s. Press pads (lower-left should be GREEN), edge buttons, and press HARD for aftertouch...");
    let _ = stdout().flush();
    std::thread::sleep(Duration::from_secs(25));

    // clean up: clear pad 11, leave programmer mode
    let dark = [0xF0, 0x00, 0x20, 0x29, 0x02, 0x0E, 0x03, 0x03, 11, 0, 0, 0, 0xF7];
    let _ = out.send(&dark);
    let _ = out.send(&PROGRAMMER_OFF);
    println!("\nDone. Released device. (press Enter)");
    let mut s = String::new();
    let _ = stdin().read_line(&mut s);
}
