# Changelog

## [0.1.6]

- Fixed false Unreadable errors for readable PDFs with Unicode element names in XML metadata. Encrypted PDFs are still rejected, and both input and output are still rendered for validation.

## [0.1.5]

- The Revert Size percent uses the original PDF as its baseline. A Compression of `-82.0%` reverts as `+82.0%`.

## [0.1.4]

- Revert runs on every selected PDF, in the same progress dialog Compress uses. A parent item contributes each of its stored or linked PDFs. A PDF with no session backup gets its own row and a short reason.

## [0.1.3]

- Item-menu Revert opens the same Zotero progress dialog Compress uses. The title is Processing. The columns are Filename and Size, with Zotero's status icon.
- Revert runs on one PDF. Compress runs on every selected PDF.
- The Size cell uses the same percent as Compression. A reverted PDF is larger than the compressed file, so the percent is a plus. A failure shows a short reason, including when the file changed after Compression and when this session has no session backup.
- When the run finishes, the line under the title says "1 PDF reverted" or "N PDFs reverted".
- Starting Revert or Compress while that dialog is open focuses the open dialog and does not add rows.
- Cancel closes the dialog. The PDF already running still finishes. Later PDFs do not start.

## [0.1.2]

- Compress opens the selected PDFs in Zotero's progress dialog. The title is Processing. The columns are Filename and Size, with Zotero's status icon.
- The Size percent is a minus when the PDF gets smaller and a plus when it gets larger. When the sizes differ but the change rounds to 0.0, the sign stays, as in `-0.0%` or `+0.0%`. Equal sizes show `0.0%`. A row that produces no PDF shows a short reason.
- When the run finishes, the line under the title says "1 PDF compressed" or "N PDFs compressed".
- The Compress PDF row on the item menu shows its icon.

## [0.1.1]

- The success message after Compression shows sizes in KB, MB, and GB, with the amount saved and the percent.
- Settings adds a Browse button on the Temporary folder row. Choosing a folder writes its absolute path. Cancelling leaves the saved value.
- A temporary folder written as `~/Downloads` is accepted.
- The item menu shows icons for Compress and Revert. Settings shows the add-on icon.

## [0.1.0]

- The item menu can compress a stored attachment or a linked attachment. A parent item with one PDF uses that PDF.
- Compression keeps a session backup of the original PDF.
- Revert puts that original back over the compressed attachment during the same Zotero session.
- The settings pane has a Temporary folder field. Leave it blank to use Zotero's temporary directory. The folder must already exist and be writable. A change applies on the next Zotero launch.
