//! A bible-rs device driven from the command line, to test Hidden Word against bible-rs's own
//! Study Library code (crates/core/src/folder.rs). Not part of bible-rs; kept in Hidden Word at
//! test/adapters/bible-rs/hwcompat.rs and copied into a bible-rs checkout to run.
//!
//!   hwcompat seed <folder> <a.db> <b.db>   two devices: highlights, notes (with a conflict),
//!                                          a bookmark, a plan with a ticked passage, deletes
//!   hwcompat sync <folder> <db>            one sync; prints the report
//!   hwcompat edit <db> <op> <args…>        note BOOK C V TEXT | unnote BOOK C V |
//!                                          highlight BOOK C V COLOR | unhighlight BOOK C V
//!   hwcompat dump <db>                     everything the store holds, as Changes JSON

use std::path::Path;

use anyhow::{Context, Result, bail};
use bible_core::folder::FolderLibrary;
use bible_core::study::{HighlightColor, StudyStore};
use bible_core::sync::{Changes, HighlightPart, HighlightsChange, MergeMode, Stamp, VerseKey};
use bible_core::{BookId, VerseRef};

fn verse(book: &str, c: &str, v: &str) -> Result<VerseRef> {
    let b = BookId::from_code(book).context("book")?;
    Ok(VerseRef::new(b, c.parse()?, v.parse()?))
}

fn color(s: &str) -> Result<HighlightColor> {
    Ok(serde_json::from_value(serde_json::Value::String(s.into()))?)
}

fn store(db: &str) -> Result<StudyStore> {
    StudyStore::open(Path::new(db))
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
    match a.as_slice() {
        ["seed", folder, da, db] => {
            let lib = FolderLibrary::open(Path::new(folder))?;
            let mut a = store(da)?;
            let mut b = store(db)?;
            a.set_highlight(verse("JHN", "3", "16")?, Some(HighlightColor::Yellow))?;
            a.set_highlight(verse("GEN", "1", "1")?, Some(HighlightColor::Green))?;
            a.set_highlight(verse("GEN", "1", "2")?, Some(HighlightColor::Pink))?;
            a.set_highlight(verse("GEN", "1", "2")?, None)?;
            a.set_note(verse("JHN", "3", "17")?, "first")?;
            a.set_note(verse("ROM", "8", "28")?, "all things")?;
            a.set_bookmark(verse("PSA", "23", "1")?, Some("shepherd"))?;
            a.start_plan("gospels-30", 1_790_000_000)?;
            a.set_plan_read("gospels-30", 1, 0, true)?;
            // Two parts of one verse, from a device that isn't in the folder.
            let mut other = Changes::default();
            let part = |c, start, end: Option<u32>, quote: Option<&str>| HighlightPart {
                color: c,
                start,
                end,
                quote: quote.map(String::from),
                created: 1_790_000_000,
                edited: 1_790_000_100,
            };
            other.highlights.push(HighlightsChange {
                verse: VerseKey { book: "PHP".into(), chapter: 4, verse: 13 },
                stamp: Stamp::new(1_790_000_100_000, "elsewhere"),
                deleted: false,
                parts: vec![
                    part(HighlightColor::Blue, 0, Some(9), Some("I can do ")),
                    part(HighlightColor::Purple, 9, None, Some("all things")),
                ],
            });
            a.merge(&other, MergeMode::Sync)?;
            lib.sync(&mut a)?;
            lib.sync(&mut b)?;
            // The same note edited on both before either syncs: a conflict copy.
            b.set_note(verse("JHN", "3", "17")?, "edited on b")?;
            std::thread::sleep(std::time::Duration::from_millis(5));
            a.set_note(verse("JHN", "3", "17")?, "edited on a")?;
            lib.sync(&mut a)?;
            lib.sync(&mut b)?;
            lib.sync(&mut a)?;
            println!("{}", serde_json::json!({"a": a.device_id(), "b": b.device_id(), "conflicts": a.conflict_count()}));
        }
        ["sync", folder, db] => {
            let lib = FolderLibrary::open(Path::new(folder))?;
            let mut s = store(db)?;
            let r = lib.sync(&mut s)?;
            println!(
                "{}",
                serde_json::json!({"device": s.device_id(), "read": r.read, "written": r.written,
                    "changed": r.merged.changed(), "conflicts": r.merged.conflicts, "waiting": r.waiting,
                    "problems": r.problems})
            );
        }
        ["edit", db, op, rest @ ..] => {
            let mut s = store(db)?;
            match (*op, rest) {
                ("note", [b, c, v, text]) => s.set_note(verse(b, c, v)?, text)?,
                ("unnote", [b, c, v]) => s.set_note(verse(b, c, v)?, "")?,
                ("highlight", [b, c, v, col]) => s.set_highlight(verse(b, c, v)?, Some(color(col)?))?,
                ("unhighlight", [b, c, v]) => s.set_highlight(verse(b, c, v)?, None)?,
                _ => bail!("unknown edit"),
            }
        }
        ["dump", db] => {
            let s = store(db)?;
            println!("{}", serde_json::to_string(&s.changes_since(0, false))?);
        }
        _ => bail!("usage: hwcompat seed|sync|edit|dump …"),
    }
    Ok(())
}
