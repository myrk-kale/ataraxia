//! Office attachments are read as data, never executed. Output names are generated, not taken from archives.
use std::io::{Cursor, Read};

use calamine::{Data, Reader};
use quick_xml::events::Event;

use super::{Error, ErrorCode, Result};

#[cfg(test)]
#[path = "office_tests.rs"]
pub(crate) mod tests;

pub const FORMATS: &[(&str, &str)] = &[
    (
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xlsx",
    ),
    ("application/vnd.ms-excel.sheet.macroEnabled.12", "xlsm"),
    ("application/vnd.ms-excel", "xls"),
    ("application/vnd.oasis.opendocument.spreadsheet", "ods"),
    ("text/csv", "csv"),
    ("text/tab-separated-values", "tsv"),
    (
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "pptx",
    ),
    ("application/vnd.oasis.opendocument.presentation", "odp"),
    ("application/vnd.oasis.opendocument.text", "odt"),
    ("text/plain", "txt"),
    ("application/json", "json"),
    ("application/xml", "xml"),
];
const MAX_EXPANDED: u64 = 64 * 1024 * 1024;
const MAX_CELLS: usize = 1_000_000;
const MAX_PARTS: usize = 200;

#[derive(Debug, Clone)]
pub struct Prepared {
    pub files: Vec<(String, Vec<u8>)>,
    pub note: String,
}

fn invalid(message: impl Into<String>) -> Error {
    Error::new(ErrorCode::Invalid, message)
}

pub fn mime(name: &str, bytes: &[u8]) -> Option<&'static str> {
    let ext = name.rsplit('.').next()?.to_ascii_lowercase();
    let (mime, _) = FORMATS.iter().find(|(_, known)| *known == ext)?;
    match ext.as_str() {
        "xls" if !bytes.starts_with(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1") => None,
        "xlsx" | "xlsm" | "ods" | "pptx" | "odp" | "odt" if !bytes.starts_with(b"PK\x03\x04") => {
            None
        }
        _ => Some(*mime),
    }
}

fn archive(bytes: &[u8]) -> Result<zip::ZipArchive<Cursor<&[u8]>>> {
    let mut zip =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| invalid("invalid Office archive"))?;
    if zip.len() > 4096 {
        return Err(invalid("Office archive has too many entries"));
    }
    let mut total = 0u64;
    for i in 0..zip.len() {
        let file = zip
            .by_index(i)
            .map_err(|_| invalid("Office archive entry could not be read"))?;
        total = total.saturating_add(file.size());
        if total > MAX_EXPANDED {
            return Err(invalid("Office archive expands beyond 64 MB"));
        }
    }
    Ok(zip)
}

fn entry(zip: &mut zip::ZipArchive<Cursor<&[u8]>>, name: &str) -> Result<Vec<u8>> {
    let file = zip
        .by_name(name)
        .map_err(|_| invalid(format!("Office archive is missing {name}")))?;
    let mut bytes = Vec::new();
    file.take(MAX_EXPANDED + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| invalid("Office archive entry could not be read"))?;
    if bytes.len() as u64 > MAX_EXPANDED {
        return Err(invalid("Office archive entry exceeds 64 MB"));
    }
    Ok(bytes)
}

fn attrs(e: &quick_xml::events::BytesStart<'_>) -> Result<Vec<(String, String)>> {
    e.attributes()
        .map(|a| {
            let a = a.map_err(|_| invalid("invalid Office XML attribute"))?;
            let key = String::from_utf8_lossy(a.key.as_ref()).into_owned();
            let value = a
                .unescape_value()
                .map_err(|_| invalid("invalid Office XML attribute"))?
                .into_owned();
            Ok((key, value))
        })
        .collect()
}

fn xml_text(bytes: &[u8], pages: bool) -> Result<Vec<String>> {
    let mut reader = quick_xml::Reader::from_reader(bytes);
    let mut output = Vec::new();
    let mut text = String::new();
    let mut in_text = 0usize;
    let mut depth = 0usize;
    let mut roots = 0usize;
    loop {
        match reader
            .read_event()
            .map_err(|_| invalid("invalid Office XML"))?
        {
            Event::Eof => break,
            Event::DocType(_) => return Err(invalid("Office XML must not contain a DTD")),
            Event::Start(e) => {
                if depth == 0 {
                    roots += 1;
                }
                depth += 1;
                match e.local_name().as_ref() {
                    b"t" | b"p" | b"h" => in_text += 1,
                    b"page" if pages => {
                        text.clear();
                    }
                    _ => {}
                }
            }
            Event::End(e) => {
                depth = depth
                    .checked_sub(1)
                    .ok_or_else(|| invalid("invalid Office XML nesting"))?;
                match e.local_name().as_ref() {
                    b"t" => in_text = in_text.saturating_sub(1),
                    b"p" | b"h" => {
                        in_text = in_text.saturating_sub(1);
                        text.push('\n');
                    }
                    b"page" if pages => {
                        if output.len() >= MAX_PARTS {
                            return Err(invalid("presentation has over 200 slides"));
                        }
                        output.push(std::mem::take(&mut text));
                    }
                    _ => {}
                }
            }
            Event::Empty(e) => {
                if depth == 0 {
                    roots += 1;
                }
                match e.local_name().as_ref() {
                    b"tab" => text.push('\t'),
                    b"br" | b"line-break" => text.push('\n'),
                    b"s" => {
                        let count = attrs(&e)?
                            .iter()
                            .find(|(k, _)| k.ends_with(":c"))
                            .map(|(_, v)| v.parse::<usize>())
                            .transpose()
                            .map_err(|_| invalid("invalid Office space count"))?
                            .unwrap_or(1);
                        if count > 10000 {
                            return Err(invalid("Office space count is too large"));
                        }
                        text.extend(std::iter::repeat_n(' ', count));
                    }
                    b"page" if pages => {
                        if output.len() >= MAX_PARTS {
                            return Err(invalid("presentation has over 200 slides"));
                        }
                        output.push(String::new());
                    }
                    _ => {}
                }
            }
            Event::Text(e) if in_text > 0 => text.push_str(
                &e.decode()
                    .map_err(|_| invalid("invalid Office text encoding"))?,
            ),
            Event::CData(e) if in_text > 0 => text.push_str(
                &e.decode()
                    .map_err(|_| invalid("invalid Office text encoding"))?,
            ),
            Event::GeneralRef(e) if in_text > 0 => {
                let value = e
                    .decode()
                    .map_err(|_| invalid("invalid Office reference"))?;
                text.push_str(
                    &quick_xml::escape::unescape(&format!("&{value};"))
                        .map_err(|_| invalid("invalid Office reference"))?,
                );
            }
            _ => {}
        }
        if text.len() as u64 > MAX_EXPANDED {
            return Err(invalid("Office text exceeds 64 MB"));
        }
    }
    if roots != 1 || depth != 0 {
        return Err(invalid("Office XML must have one complete root element"));
    }
    if !pages {
        output.push(text);
    }
    if output.len() > MAX_PARTS {
        return Err(invalid("presentation has over 200 slides"));
    }
    Ok(output)
}

fn plain_text(bytes: &[u8], legacy: bool) -> Result<String> {
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    if bytes.starts_with(b"\xff\xfe") || bytes.starts_with(b"\xfe\xff") {
        let (encoding, _) = encoding_rs::Encoding::for_bom(bytes)
            .ok_or_else(|| invalid("invalid text encoding"))?;
        let (text, _, errors) = encoding.decode(bytes);
        if errors || text.contains('\0') {
            return Err(invalid("invalid UTF-16 text"));
        }
        return Ok(text.into_owned());
    }
    match std::str::from_utf8(bytes) {
        Ok(text) if !text.contains('\0') => Ok(text.to_string()),
        Err(_) if legacy && !bytes.contains(&0) => {
            Ok(encoding_rs::WINDOWS_1252.decode(bytes).0.into_owned())
        }
        _ => Err(invalid(
            "text document contains binary or invalid text data",
        )),
    }
}

fn csv_bytes(records: impl IntoIterator<Item = Vec<String>>) -> Result<Vec<u8>> {
    let mut writer = csv::WriterBuilder::new()
        .flexible(true)
        .from_writer(Vec::new());
    for record in records {
        writer
            .write_record(record)
            .map_err(|_| invalid("could not export spreadsheet cells"))?;
    }
    writer
        .into_inner()
        .map_err(|_| invalid("could not finish spreadsheet export"))
}

fn delimited(bytes: &[u8], tsv: bool) -> Result<Prepared> {
    let text = plain_text(bytes, true)?;
    let delimiter = if tsv {
        b'\t'
    } else {
        [b',', b';', b'\t']
            .into_iter()
            .max_by_key(|delimiter| {
                csv::ReaderBuilder::new()
                    .has_headers(false)
                    .delimiter(*delimiter)
                    .from_reader(text.as_bytes())
                    .records()
                    .take(20)
                    .filter_map(std::result::Result::ok)
                    .map(|r| r.len())
                    .sum::<usize>()
            })
            .unwrap_or(b',')
    };
    let mut cells = 0usize;
    let mut records = Vec::new();
    for row in csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .delimiter(delimiter)
        .from_reader(text.as_bytes())
        .records()
    {
        let row = row.map_err(|_| invalid("invalid CSV/TSV record"))?;
        cells += row.len();
        if cells > MAX_CELLS {
            return Err(invalid("spreadsheet exceeds 1,000,000 cells"));
        }
        records.push(row.iter().map(str::to_string).collect());
    }
    Ok(Prepared { files: vec![("sheet-0001.csv".into(), csv_bytes(records)?)], note: "Delimited text normalized to UTF-8 CSV. Quoted separators and multiline cells are preserved.\n".into() })
}

// Limit cell coordinates before Calamine materializes sparse worksheets into dense arrays.
fn check_zip_grid(zip: &mut zip::ZipArchive<Cursor<&[u8]>>) -> Result<()> {
    let mut total_cells = 0usize;
    let mut sheets = 0usize;
    let names: Vec<_> = zip
        .file_names()
        .filter(|n| {
            (n.starts_with("xl/worksheets/") && n.ends_with(".xml"))
                || *n == "content.xml"
                || *n == "xl/workbook.xml"
        })
        .map(str::to_string)
        .collect();
    for name in names {
        let data = entry(zip, &name)?;
        let mut reader = quick_xml::Reader::from_reader(data.as_slice());
        let (mut rows, mut columns) = (0usize, 0usize);
        let mut repeated_rows = 0usize;
        loop {
            match reader
                .read_event()
                .map_err(|_| invalid("invalid spreadsheet XML"))?
            {
                Event::Eof => break,
                Event::DocType(_) => return Err(invalid("spreadsheet XML must not contain a DTD")),
                Event::End(e) if e.local_name().as_ref() == b"table" => {
                    total_cells = total_cells.saturating_add(rows.saturating_mul(columns));
                    rows = 0;
                    columns = 0;
                    if total_cells > MAX_CELLS {
                        return Err(invalid("workbook exceeds 1,000,000 cells"));
                    }
                }
                Event::Start(e) | Event::Empty(e) => {
                    if matches!(e.local_name().as_ref(), b"table" | b"sheet") {
                        sheets += 1;
                        if sheets > MAX_PARTS {
                            return Err(invalid("workbook has over 200 sheets"));
                        }
                    }
                    if e.local_name().as_ref() == b"table" {
                        rows = 0;
                        columns = 0;
                    }
                    if e.local_name().as_ref() == b"table-row" {
                        repeated_rows = 0;
                        rows += 1;
                    }
                    if e.local_name().as_ref() == b"row" {
                        repeated_rows = 0;
                    }
                    if e.local_name().as_ref() == b"c" {
                        repeated_rows += 1;
                        columns = columns.max(repeated_rows);
                    }
                    let a = attrs(&e)?;
                    for (key, value) in a {
                        if key == "r" && e.local_name().as_ref() == b"row" {
                            rows = rows.max(
                                value
                                    .parse::<usize>()
                                    .map_err(|_| invalid("invalid spreadsheet row"))?,
                            );
                        }
                        if key == "r" && e.local_name().as_ref() == b"c" {
                            let col = value
                                .bytes()
                                .take_while(u8::is_ascii_alphabetic)
                                .try_fold(0usize, |n, c| {
                                    n.checked_mul(26)?
                                        .checked_add((c.to_ascii_uppercase() - b'A' + 1) as usize)
                                })
                                .ok_or_else(|| invalid("invalid spreadsheet column"))?;
                            let row = value
                                .trim_start_matches(|c: char| c.is_ascii_alphabetic())
                                .parse::<usize>()
                                .map_err(|_| invalid("invalid spreadsheet row"))?;
                            rows = rows.max(row);
                            columns = columns.max(col);
                            repeated_rows = col;
                        }
                        if key.ends_with(":number-rows-repeated") {
                            rows = rows.saturating_add(
                                value
                                    .parse::<usize>()
                                    .map_err(|_| invalid("invalid repeated row count"))?
                                    .saturating_sub(1),
                            );
                        }
                        if key.ends_with(":number-columns-repeated")
                            && e.local_name().as_ref() != b"table-column"
                        {
                            repeated_rows = repeated_rows.saturating_add(
                                value
                                    .parse::<usize>()
                                    .map_err(|_| invalid("invalid repeated column count"))?
                                    .saturating_sub(1),
                            );
                        }
                    }
                    if matches!(
                        e.local_name().as_ref(),
                        b"table-cell" | b"covered-table-cell"
                    ) {
                        repeated_rows = repeated_rows.saturating_add(1);
                        columns = columns.max(repeated_rows);
                    }
                    if rows.saturating_mul(columns) > MAX_CELLS {
                        return Err(invalid("spreadsheet used area exceeds 1,000,000 cells"));
                    }
                }
                _ => {}
            }
        }
        total_cells = total_cells.saturating_add(rows.saturating_mul(columns));
        if total_cells > MAX_CELLS {
            return Err(invalid("workbook exceeds 1,000,000 cells"));
        }
    }
    Ok(())
}

fn check_xls_grid(bytes: &[u8]) -> Result<()> {
    let mut compound = cfb::CompoundFile::open(Cursor::new(bytes))
        .map_err(|_| invalid("invalid XLS compound file"))?;
    let name = if compound.exists("/Workbook") {
        "/Workbook"
    } else {
        "/Book"
    };
    let stream = compound
        .open_stream(name)
        .map_err(|_| invalid("XLS workbook stream is missing"))?;
    let mut data = Vec::new();
    stream
        .take(MAX_EXPANDED + 1)
        .read_to_end(&mut data)
        .map_err(|_| invalid("XLS workbook stream could not be read"))?;
    if data.len() as u64 > MAX_EXPANDED {
        return Err(invalid("XLS workbook stream exceeds 64 MB"));
    }
    let (mut rows, mut columns) = (0usize, 0usize);
    let mut total_cells = 0usize;
    let mut sheets = 0usize;
    let mut pos = 0usize;
    while pos + 4 <= data.len() {
        let kind = u16::from_le_bytes([data[pos], data[pos + 1]]);
        let len = u16::from_le_bytes([data[pos + 2], data[pos + 3]]) as usize;
        pos += 4;
        let record = data
            .get(pos..pos + len)
            .ok_or_else(|| invalid("truncated XLS record"))?;
        if kind == 0x0085 {
            sheets += 1;
            if sheets > MAX_PARTS {
                return Err(invalid("workbook has over 200 sheets"));
            }
        }
        if kind == 0x000a {
            total_cells = total_cells.saturating_add(rows.saturating_mul(columns));
            if total_cells > MAX_CELLS {
                return Err(invalid("workbook exceeds 1,000,000 cells"));
            }
            rows = 0;
            columns = 0;
        }
        if kind == 0x0200 {
            let (end_row, end_col) = match len {
                10 => (
                    u16::from_le_bytes([record[2], record[3]]) as usize,
                    u16::from_le_bytes([record[6], record[7]]) as usize,
                ),
                14 | 16 => (
                    u32::from_le_bytes(
                        record[4..8]
                            .try_into()
                            .map_err(|_| invalid("invalid XLS dimensions"))?,
                    ) as usize,
                    u16::from_le_bytes([record[10], record[11]]) as usize,
                ),
                _ => return Err(invalid("invalid XLS dimensions")),
            };
            if end_row.saturating_mul(end_col) > MAX_CELLS {
                return Err(invalid("XLS dimensions exceed 1,000,000 cells"));
            }
        }
        if matches!(
            kind,
            0x0203 | 0x00fd | 0x027e | 0x00bd | 0x0205 | 0x0006 | 0x0204 | 0x0201 | 0x00be | 0x00d6
        ) && len >= 4
        {
            rows = rows.max(u16::from_le_bytes([record[0], record[1]]) as usize + 1);
            columns = columns.max(u16::from_le_bytes([record[2], record[3]]) as usize + 1);
            if matches!(kind, 0x00bd | 0x00be) && len >= 6 {
                columns = columns
                    .max(u16::from_le_bytes([record[len - 2], record[len - 1]]) as usize + 1);
            }
            if rows.saturating_mul(columns) > MAX_CELLS {
                return Err(invalid("spreadsheet used area exceeds 1,000,000 cells"));
            }
        }
        pos += len;
    }
    Ok(())
}

fn workbook(bytes: &[u8], xls: bool) -> Result<Prepared> {
    if xls {
        check_xls_grid(bytes)?;
    } else {
        check_zip_grid(&mut archive(bytes)?)?;
    }
    let mut book = calamine::open_workbook_auto_from_rs(Cursor::new(bytes))
        .map_err(|_| invalid("spreadsheet could not be read (invalid or encrypted workbook)"))?;
    let names = book.sheet_names();
    if names.is_empty() || names.len() > MAX_PARTS {
        return Err(invalid("workbook must contain 1 to 200 sheets"));
    }
    let mut files = Vec::new();
    let mut index = Vec::new();
    let mut total = 0usize;
    let mut cells = 0usize;
    for (i, name) in names.iter().enumerate() {
        let range = book
            .worksheet_range(name)
            .map_err(|_| invalid(format!("sheet {name:?} could not be read")))?;
        let size = range.get_size();
        cells = cells.saturating_add(size.0.saturating_mul(size.1));
        if cells > MAX_CELLS {
            return Err(invalid("workbook exceeds 1,000,000 cells"));
        }
        let data = csv_bytes(range.rows().map(|r| {
            r.iter()
                .map(|cell| match cell {
                    Data::DateTime(value) if value.is_duration() => value
                        .as_duration()
                        .map(|d| d.to_string())
                        .unwrap_or_else(|| value.to_string()),
                    Data::DateTime(value) => value
                        .as_datetime()
                        .map(|d| d.to_string())
                        .unwrap_or_else(|| value.to_string()),
                    _ => cell.to_string(),
                })
                .collect()
        }))?;
        let filename = format!("sheet-{:04}.csv", i + 1);
        total += data.len();
        files.push((filename.clone(), data));
        let formulas = book.worksheet_formula(name);
        let formula_error = formulas.as_ref().err().map(|e| format!("{e:?}"));
        let formulas_file = if let Some(formulas) = formulas
            .as_ref()
            .ok()
            .filter(|f| f.used_cells().next().is_some())
        {
            let data = csv_bytes(formulas.used_cells().map(|(r, c, f)| {
                let start = formulas.start().unwrap_or((0, 0));
                vec![
                    (start.0 as usize + r + 1).to_string(),
                    (start.1 as usize + c + 1).to_string(),
                    f.to_string(),
                ]
            }))?;
            let file = format!("sheet-{:04}-formulas.csv", i + 1);
            total += data.len();
            files.push((file.clone(), data));
            Some(file)
        } else {
            None
        };
        if total as u64 > MAX_EXPANDED {
            return Err(invalid("spreadsheet exports exceed 64 MB"));
        }
        index.push(serde_json::json!({"name":name,"values":filename,"formulas":formulas_file,"formula_error":formula_error,"origin":range.start(),"rows":size.0,"columns":size.1}));
    }
    files.push((
        "sheets.json".into(),
        serde_json::to_vec_pretty(&index).map_err(|_| invalid("could not write sheet index"))?,
    ));
    Ok(Prepared { files, note: "Read sheets.json for sheet order, names and zero-based origins of the trimmed CSV ranges. Each sheet has a UTF-8 values CSV; formula CSVs list absolute 1-based row, column and formula. Values are saved/cached results, not recalculated. Dates use ISO text when recognized. Macros, external links, charts and formatting are not executed or rendered; the original workbook is preserved.\n".into() })
}

fn presentation(bytes: &[u8]) -> Result<Prepared> {
    let mut zip = archive(bytes)?;
    let data = entry(&mut zip, "ppt/presentation.xml")?;
    let mut reader = quick_xml::Reader::from_reader(data.as_slice());
    let mut ids = Vec::new();
    loop {
        match reader
            .read_event()
            .map_err(|_| invalid("invalid presentation XML"))?
        {
            Event::Eof => break,
            Event::DocType(_) => return Err(invalid("presentation XML must not contain a DTD")),
            Event::Empty(e) | Event::Start(e) if e.local_name().as_ref() == b"sldId" => {
                let id = attrs(&e)?
                    .into_iter()
                    .find(|(k, _)| k.ends_with(":id"))
                    .map(|(_, v)| v)
                    .ok_or_else(|| invalid("slide has no relationship id"))?;
                ids.push(id);
            }
            _ => {}
        }
    }
    if ids.is_empty() || ids.len() > MAX_PARTS {
        return Err(invalid("presentation must contain 1 to 200 slides"));
    }
    let rels = entry(&mut zip, "ppt/_rels/presentation.xml.rels")?;
    let mut reader = quick_xml::Reader::from_reader(rels.as_slice());
    let mut targets = std::collections::HashMap::new();
    loop {
        match reader
            .read_event()
            .map_err(|_| invalid("invalid presentation relationships"))?
        {
            Event::Eof => break,
            Event::DocType(_) => return Err(invalid("presentation XML must not contain a DTD")),
            Event::Empty(e) | Event::Start(e) if e.local_name().as_ref() == b"Relationship" => {
                let a: std::collections::HashMap<_, _> = attrs(&e)?.into_iter().collect();
                if a.get("Type").is_some_and(|v| v.ends_with("/slide"))
                    && a.get("TargetMode").is_none_or(|v| v != "External")
                {
                    if let (Some(id), Some(target)) = (a.get("Id"), a.get("Target")) {
                        targets.insert(id.clone(), target.clone());
                    }
                }
            }
            _ => {}
        }
    }
    let mut files = Vec::new();
    for (i, id) in ids.iter().enumerate() {
        let target = targets
            .get(id)
            .ok_or_else(|| invalid("slide relationship is missing or external"))?;
        let path = target.strip_prefix("/ppt/").unwrap_or(target);
        if !path.starts_with("slides/") || path.split('/').any(|c| c == ".." || c == ".") {
            return Err(invalid("invalid slide path"));
        }
        let text = xml_text(&entry(&mut zip, &format!("ppt/{path}"))?, false)?.join("");
        files.push((format!("slide-{:04}.txt", i + 1), text.into_bytes()));
    }
    Ok(Prepared { files, note: "Slides exported as text in presentation order. Images, speaker notes, animations and layout remain in the original presentation.\n".into() })
}

pub fn prepare(mime: &str, bytes: &[u8]) -> Result<Option<Prepared>> {
    let Some((_, ext)) = FORMATS.iter().find(|(known, _)| *known == mime) else {
        return Ok(None);
    };
    let prepared = match *ext {
        "xlsx" | "xlsm" | "xls" | "ods" => workbook(bytes, *ext == "xls")?,
        "csv" | "tsv" => delimited(bytes, *ext == "tsv")?,
        "pptx" => presentation(bytes)?,
        "odt" | "odp" => {
            let mut zip = archive(bytes)?;
            let expected = if *ext == "odt" {
                "application/vnd.oasis.opendocument.text"
            } else {
                "application/vnd.oasis.opendocument.presentation"
            };
            if entry(&mut zip, "mimetype")? != expected.as_bytes() {
                return Err(invalid("OpenDocument content does not match its file type"));
            }
            let pages = xml_text(&entry(&mut zip, "content.xml")?, *ext == "odp")?;
            if pages.is_empty() {
                return Err(invalid("presentation has no slides"));
            }
            Prepared { files: pages.into_iter().enumerate().map(|(i,t)| (if *ext == "odp" { format!("slide-{:04}.txt",i+1) } else { "document.txt".into() },t.into_bytes())).collect(), note: "OpenDocument text extracted in document order. Images and visual formatting remain in the original file.\n".into() }
        }
        _ => {
            let text = plain_text(bytes, *ext == "txt")?;
            if *ext == "json" {
                serde_json::from_str::<serde_json::Value>(&text)
                    .map_err(|_| invalid("invalid JSON document"))?;
            }
            if *ext == "xml" {
                xml_text(text.as_bytes(), false)?;
            }
            Prepared {
                files: vec![(format!("document.{ext}"), text.into_bytes())],
                note: "Text normalized to UTF-8. The original file is preserved.\n".into(),
            }
        }
    };
    if prepared
        .files
        .iter()
        .map(|(_, b)| b.len() as u64)
        .sum::<u64>()
        > MAX_EXPANDED
    {
        return Err(invalid("Office exports exceed 64 MB"));
    }
    Ok(Some(prepared))
}
