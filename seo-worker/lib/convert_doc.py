#!/usr/bin/env python3
"""聊天附件转文本：xlsx / xls / docx -> 模型可 Read 的纯文本。

用法: python3 convert_doc.py <src> <dst>
成功写 dst 退 0；失败往 stderr 写一句人话退 1（调用方把这句放进会话备注）。
零第三方依赖优先：xlsx 与 docx 走标准库 zipfile+xml，xls 用 xlrd（ros 已装 2.0.2，
xlrd 2.x 恰好只支持 .xls 老格式）。日期在 xlsx 里是序列数，按原值输出并在文件头注明。
输出上限 200 万字符、每表 2 万行，超限截断并标注，防 5MB 表格撑爆上下文。
"""
import sys
import html
import re
import zipfile
import xml.etree.ElementTree as ET

MAX_CHARS = 2_000_000
MAX_ROWS = 20_000
NS_MAIN = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
NS_REL = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'


def die(msg):
    sys.stderr.write(msg + '\n')
    sys.exit(1)


def csv_cell(v):
    v = str(v)
    if any(c in v for c in ',"\n'):
        v = '"' + v.replace('"', '""') + '"'
    return v


def col_index(ref):
    n = 0
    for ch in ref:
        if ch.isalpha():
            n = n * 26 + (ord(ch.upper()) - 64)
        else:
            break
    return n - 1


def xlsx_to_text(src):
    z = zipfile.ZipFile(src)
    shared = []
    if 'xl/sharedStrings.xml' in z.namelist():
        root = ET.fromstring(z.read('xl/sharedStrings.xml'))
        for si in root.findall(NS_MAIN + 'si'):
            shared.append(''.join(t.text or '' for t in si.iter(NS_MAIN + 't')))
    # sheet 名与文件的对应关系：workbook.xml 的 sheet 顺序 + rels
    names = []
    try:
        wb = ET.fromstring(z.read('xl/workbook.xml'))
        rels = {}
        rl = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
        for r in rl:
            rels[r.get('Id')] = r.get('Target').lstrip('/')
        for sh in wb.iter(NS_MAIN + 'sheet'):
            target = rels.get(sh.get(NS_REL + 'id'), '')
            if target and not target.startswith('xl/'):
                target = 'xl/' + target
            names.append((sh.get('name') or 'Sheet', target))
    except Exception:
        names = [(p.split('/')[-1], p) for p in z.namelist() if re.match(r'xl/worksheets/sheet\d+\.xml$', p)]
    out = ['（由 xlsx 转出，公式取计算值，日期列可能显示为 Excel 序列数）']
    for name, target in names:
        if not target or target not in z.namelist():
            continue
        out.append('=== Sheet: %s ===' % name)
        root = ET.fromstring(z.read(target))
        rows = 0
        for row in root.iter(NS_MAIN + 'row'):
            if rows >= MAX_ROWS:
                out.append('（该表超过 %d 行，已截断）' % MAX_ROWS)
                break
            cells = {}
            for c in row.findall(NS_MAIN + 'c'):
                idx = col_index(c.get('r') or '')
                t = c.get('t') or ''
                v = ''
                if t == 'inlineStr':
                    v = ''.join(x.text or '' for x in c.iter(NS_MAIN + 't'))
                else:
                    ve = c.find(NS_MAIN + 'v')
                    if ve is not None and ve.text is not None:
                        v = shared[int(ve.text)] if (t == 's' and ve.text.isdigit() and int(ve.text) < len(shared)) else ve.text
                if idx >= 0:
                    cells[idx] = v
            if cells:
                width = max(cells) + 1
                out.append(','.join(csv_cell(cells.get(i, '')) for i in range(width)))
            rows += 1
        out.append('')
    return '\n'.join(out)


def xls_to_text(src):
    try:
        import xlrd
    except ImportError:
        die('.xls 需要 xlrd 库而本机没装，请把文件另存为 .xlsx 或 .csv 再发')
    book = xlrd.open_workbook(src)
    out = ['（由 xls 转出，日期列可能显示为 Excel 序列数）']
    for sheet in book.sheets():
        out.append('=== Sheet: %s ===' % sheet.name)
        for r in range(min(sheet.nrows, MAX_ROWS)):
            out.append(','.join(csv_cell(sheet.cell_value(r, c)) for c in range(sheet.ncols)))
        if sheet.nrows > MAX_ROWS:
            out.append('（该表超过 %d 行，已截断）' % MAX_ROWS)
        out.append('')
    return '\n'.join(out)


def docx_to_text(src):
    z = zipfile.ZipFile(src)
    if 'word/document.xml' not in z.namelist():
        die('docx 里没有 word/document.xml，可能不是有效的 Word 文档')
    xmls = z.read('word/document.xml').decode('utf-8', 'replace')
    xmls = re.sub(r'</w:p>', '\n', xmls)
    xmls = re.sub(r'<w:tab[^>]*/>', '\t', xmls)
    xmls = re.sub(r'<[^>]+>', '', xmls)
    return html.unescape(xmls)


def main():
    if len(sys.argv) != 3:
        die('用法: convert_doc.py <src> <dst>')
    src, dst = sys.argv[1], sys.argv[2]
    ext = src.rsplit('.', 1)[-1].lower()
    try:
        if ext == 'xlsx':
            text = xlsx_to_text(src)
        elif ext == 'xls':
            text = xls_to_text(src)
        elif ext == 'docx':
            text = docx_to_text(src)
        else:
            die('不认识的格式 .' + ext)
    except zipfile.BadZipFile:
        die('文件不是有效的 Office 文档（zip 解不开）')
    except Exception as e:
        die('转换失败：' + str(e)[:200])
    if len(text) > MAX_CHARS:
        text = text[:MAX_CHARS] + '\n（输出超过 %d 字符，已截断，要看全量请拆小文件）' % MAX_CHARS
    with open(dst, 'w', encoding='utf-8') as f:
        f.write(text)


if __name__ == '__main__':
    main()
