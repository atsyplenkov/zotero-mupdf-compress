# MuPDF Compress for Zotero

Vocabulary for the extension's PDF attachment compression and session-only restoration behavior.

## Language

**Compression**:
Production of a smaller PDF from an existing attachment while retaining the same Zotero attachment item.
_Avoid_: Optimization

**Session backup**:
An original PDF retained temporarily so its attachment can be reverted during one Zotero session.
_Avoid_: Permanent backup, cache entry

**Stored attachment**:
A PDF file held in Zotero-managed storage and eligible for Zotero file sync.
_Avoid_: Stored copy, imported attachment

**Linked attachment**:
A PDF file outside Zotero-managed storage that an attachment item references by local path.
_Avoid_: Linked file, external attachment

**Revert**:
Restoration of an original PDF over its compressed attachment during the same Zotero session.
_Avoid_: Undo compression, Restore
