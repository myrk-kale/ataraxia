use std::io::Write;

use super::*;

pub(crate) fn zip_files(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in files {
        zip.start_file(
            *name,
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated),
        )
        .unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

pub(crate) fn xlsx() -> Vec<u8> {
    zip_files(&[
        ("xl/workbook.xml", br#"<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sales &amp; data" sheetId="1" r:id="rId1"/><sheet name="Empty" sheetId="2" r:id="rId2"/></sheets></workbook>"#),
        ("xl/_rels/workbook.xml.rels", br#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/><Relationship Id="rId2" Target="worksheets/sheet2.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/></Relationships>"#),
        ("xl/styles.xml", br#"<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>"#),
        ("xl/worksheets/sheet1.xml", "<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><dimension ref=\"B2:F2\"/><sheetData><row r=\"2\"><c r=\"B2\" t=\"inlineStr\"><is><t>Café, &quot;Q1&quot;\nNext</t></is></c><c r=\"C2\" t=\"b\"><v>1</v></c><c r=\"D2\"><v>42</v></c><c r=\"E2\"><f>SUM(D2,1)</f><v>43</v></c><c r=\"F2\" s=\"1\"><v>45000</v></c></row></sheetData></worksheet>".as_bytes()),
        ("xl/worksheets/sheet2.xml", br#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>"#),
    ])
}

fn file<'a>(prepared: &'a Prepared, name: &str) -> &'a [u8] {
    &prepared.files.iter().find(|(n, _)| n == name).unwrap().1
}

#[test]
fn excel_keeps_sheet_order_coordinates_values_formulas_and_empty_sheets() {
    let p = prepare(FORMATS[0].0, &xlsx()).unwrap().unwrap();
    let index: serde_json::Value = serde_json::from_slice(file(&p, "sheets.json")).unwrap();
    assert_eq!(index[0]["name"], "Sales & data");
    assert_eq!(index[0]["origin"], serde_json::json!([1, 1]));
    assert_eq!(index[1]["name"], "Empty");
    assert!(file(&p, "sheet-0002.csv").is_empty());
    let row = csv::ReaderBuilder::new()
        .has_headers(false)
        .from_reader(file(&p, "sheet-0001.csv"))
        .records()
        .next()
        .unwrap()
        .unwrap();
    assert_eq!(&row[0], "Café, \"Q1\"\nNext");
    assert_eq!(&row[1], "true");
    assert_eq!(&row[2], "42");
    assert_eq!(&row[3], "43");
    assert!(row[4].starts_with("2023-03-15"), "{}", &row[4]);
    assert_eq!(
        std::str::from_utf8(file(&p, "sheet-0001-formulas.csv")).unwrap(),
        "2,5,\"SUM(D2,1)\"\n"
    );
    assert!(
        prepare(FORMATS[1].0, &xlsx()).unwrap().is_some(),
        "XLSM uses the same data reader without running macros"
    );
}

#[test]
fn legacy_xls_is_read_with_separate_sheet_files() {
    let bytes = include_bytes!("../../tests/fixtures/office/sheet_names_order.xls");
    let p = prepare("application/vnd.ms-excel", bytes).unwrap().unwrap();
    let index: serde_json::Value = serde_json::from_slice(file(&p, "sheets.json")).unwrap();
    assert!(index.as_array().unwrap().len() >= 2);
    assert!(p.files.iter().any(|(n, _)| n == "sheet-0002.csv"));
}

#[test]
fn ods_values_repeated_cells_and_formulas_are_extracted() {
    let bytes = zip_files(&[
        ("mimetype",b"application/vnd.oasis.opendocument.spreadsheet"),
        ("META-INF/manifest.xml",br#"<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>"#),
        ("content.xml",br#"<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:spreadsheet><table:table table:name="Budget"><table:table-row><table:table-cell office:value-type="string"><text:p>Sales</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2" office:value-type="float" office:value="12"/><table:table-cell table:formula="of:=SUM([.B1:.C1])" office:value-type="float" office:value="24"/></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>"#),
    ]);
    let p = prepare("application/vnd.oasis.opendocument.spreadsheet", &bytes)
        .unwrap()
        .unwrap();
    assert_eq!(
        std::str::from_utf8(file(&p, "sheet-0001.csv")).unwrap(),
        "Sales,12,12,24\n"
    );
    assert!(p.files.iter().any(|(n, _)| n.ends_with("formulas.csv")));
}

#[test]
fn csv_accepts_office_encodings_semicolons_and_quoted_multiline_fields() {
    let text = "nome;valor\r\n\"Café; um\nitem\";1,25\r\n";
    let bytes = encoding_rs::WINDOWS_1252.encode(text).0.into_owned();
    let p = prepare("text/csv", &bytes).unwrap().unwrap();
    let records: Vec<_> = csv::ReaderBuilder::new()
        .has_headers(false)
        .from_reader(file(&p, "sheet-0001.csv"))
        .records()
        .map(std::result::Result::unwrap)
        .collect();
    assert_eq!(
        records[1].iter().collect::<Vec<_>>(),
        ["Café; um\nitem", "1,25"]
    );
    let mut utf16 = vec![0xff, 0xfe];
    for unit in "a\tb\n1\t2\n".encode_utf16() {
        utf16.extend(unit.to_le_bytes());
    }
    let p = prepare("text/tab-separated-values", &utf16)
        .unwrap()
        .unwrap();
    assert_eq!(file(&p, "sheet-0001.csv"), b"a,b\n1,2\n");
}

#[test]
fn pptx_follows_presentation_order_instead_of_slide_filenames() {
    let bytes = zip_files(&[
        ("ppt/presentation.xml",br#"<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="2" r:id="second"/><p:sldId id="1" r:id="first"/></p:sldIdLst></p:presentation>"#),
        ("ppt/_rels/presentation.xml.rels",br#"<Relationships><Relationship Id="first" Target="slides/slide1.xml" Type="office/slide"/><Relationship Id="second" Target="slides/slide2.xml" Type="office/slide"/></Relationships>"#),
        ("ppt/slides/slide1.xml",br#"<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>First &amp; one</a:t></a:r></a:p></p:sld>"#),
        ("ppt/slides/slide2.xml",br#"<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:sld>"#),
    ]);
    let p = prepare(FORMATS[6].0, &bytes).unwrap().unwrap();
    assert_eq!(file(&p, "slide-0001.txt"), b"Second\n");
    assert_eq!(file(&p, "slide-0002.txt"), b"First & one\n");
}

#[test]
fn opendocument_text_and_presentations_preserve_text_and_slide_boundaries() {
    let content = br#"<office:document-content xmlns:office="office" xmlns:draw="draw" xmlns:text="text"><office:body><office:presentation><draw:page><text:p>One &amp; <text:span>two</text:span></text:p></draw:page><draw:page><text:p>Three<text:tab/>four</text:p></draw:page></office:presentation></office:body></office:document-content>"#;
    let bytes = zip_files(&[
        (
            "mimetype",
            b"application/vnd.oasis.opendocument.presentation",
        ),
        ("content.xml", content),
    ]);
    let p = prepare(FORMATS[7].0, &bytes).unwrap().unwrap();
    assert_eq!(file(&p, "slide-0001.txt"), b"One & two\n");
    assert_eq!(file(&p, "slide-0002.txt"), b"Three\tfour\n");
    let bytes = zip_files(&[("mimetype",b"application/vnd.oasis.opendocument.text"),("content.xml",br#"<office:document-content xmlns:office="office" xmlns:text="text"><office:body><office:text><text:p>Report</text:p></office:text></office:body></office:document-content>"#)]);
    let p = prepare(FORMATS[8].0, &bytes).unwrap().unwrap();
    assert_eq!(file(&p, "document.txt"), b"Report\n");
}

#[test]
fn invalid_documents_and_oversized_sparse_sheets_are_rejected() {
    for (mime, bytes) in [
        (FORMATS[0].0, b"PK\x03\x04broken".as_slice()),
        ("application/vnd.ms-excel", b"not an XLS"),
        ("application/json", b"{broken"),
        (
            "application/xml",
            b"<!DOCTYPE x [<!ENTITY a SYSTEM 'file:///tmp/x'>]><x>&a;</x>",
        ),
    ] {
        assert!(prepare(mime, bytes).is_err(), "{mime}");
    }
    let bytes = zip_files(&[("xl/worksheets/sheet1.xml",br#"<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="1048576"><c r="XFD1048576"><v>2</v></c></row></sheetData></worksheet>"#)]);
    assert!(
        prepare(FORMATS[0].0, &bytes)
            .unwrap_err()
            .message
            .contains("1,000,000")
    );
    let bytes = zip_files(&[("content.xml",br#"<document><table><table-row xmlns:table="table" table:number-rows-repeated="100000000"><table-cell table:number-columns-repeated="1000000"/></table-row></table></document>"#)]);
    assert!(
        prepare(FORMATS[3].0, &bytes)
            .unwrap_err()
            .message
            .contains("1,000,000")
    );
}

#[test]
fn xls_dimensions_are_bounded_before_the_reader_reserves_memory() {
    let mut compound = cfb::CompoundFile::create(Cursor::new(Vec::new())).unwrap();
    let mut record = vec![0u8; 14];
    record[4..8].copy_from_slice(&1_000_000u32.to_le_bytes());
    record[10..12].copy_from_slice(&1000u16.to_le_bytes());
    {
        let mut stream = compound.create_stream("/Workbook").unwrap();
        stream.write_all(&[0x00, 0x02, 14, 0]).unwrap();
        stream.write_all(&record).unwrap();
    }
    let bytes = compound.into_inner().into_inner();
    assert!(
        prepare("application/vnd.ms-excel", &bytes)
            .unwrap_err()
            .message
            .contains("dimensions")
    );
}

#[test]
fn compressed_archives_have_an_expansion_budget() {
    let data = vec![b' '; MAX_EXPANDED as usize + 1];
    let bytes = zip_files(&[("content.xml", &data)]);
    assert!(
        prepare(FORMATS[3].0, &bytes)
            .unwrap_err()
            .message
            .contains("64 MB")
    );
}

#[test]
fn implicit_excel_cell_positions_and_many_sheets_are_bounded_before_parsing() {
    let bytes = zip_files(&[(
        "xl/worksheets/sheet1.xml",
        br#"<worksheet><sheetData><row r="1048576"><c><v>1</v></c></row></sheetData></worksheet>"#,
    )]);
    assert!(
        prepare(FORMATS[0].0, &bytes)
            .unwrap_err()
            .message
            .contains("1,000,000")
    );
    let xml = format!(
        "<workbook><sheets>{}</sheets></workbook>",
        "<sheet/>".repeat(201)
    );
    let bytes = zip_files(&[("xl/workbook.xml", xml.as_bytes())]);
    assert!(
        prepare(FORMATS[0].0, &bytes)
            .unwrap_err()
            .message
            .contains("200 sheets")
    );
}

#[test]
fn ods_cell_budget_is_shared_by_all_sheets_before_dense_ranges_are_loaded() {
    let table = "<table><table-row xmlns:table='table' table:number-rows-repeated='1000'><table-cell table:number-columns-repeated='600'/></table-row></table>";
    let xml = format!("<document>{table}{table}</document>");
    let bytes = zip_files(&[("content.xml", xml.as_bytes())]);
    assert!(
        prepare(FORMATS[3].0, &bytes)
            .unwrap_err()
            .message
            .contains("1,000,000")
    );
}

#[test]
fn reversed_xls_dimensions_are_rejected_before_range_allocation() {
    let mut compound = cfb::CompoundFile::create(Cursor::new(Vec::new())).unwrap();
    let mut record = vec![0u8; 14];
    record[0..4].copy_from_slice(&100u32.to_le_bytes());
    record[4..8].copy_from_slice(&2u32.to_le_bytes());
    record[10..12].copy_from_slice(&2u16.to_le_bytes());
    {
        let mut stream = compound.create_stream("/Workbook").unwrap();
        stream.write_all(&[0x00, 0x02, 14, 0]).unwrap();
        stream.write_all(&record).unwrap();
    }
    let bytes = compound.into_inner().into_inner();
    assert!(
        prepare("application/vnd.ms-excel", &bytes)
            .unwrap_err()
            .message
            .contains("reversed")
    );
}
