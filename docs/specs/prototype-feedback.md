# Prototype feedback

Accepted for [ticket #7](https://github.com/atsyplenkov/zotero-mupdf-compress/issues/7). This specifies the single-PDF Linux prototype's feedback; it does not establish that the UI has been implemented or tested in Zotero.

## Progress and results

Use a small, non-modal progress window for each operation. Show the attachment title, action, and current stage: backing up, compressing, validating, replacing, or reverting as applicable. Progress is indeterminate; do not invent a completion percentage. This is not a batch interface.

Reuse the same window for the result. There is no Cancel control. Closing the window does not cancel the operation; say this while work is running. If it was closed, reopen it when the operation finishes. Reject another action on the same busy attachment with an explanation, without interrupting its running operation.

Successful Compress shows original and final file sizes, bytes and percentage saved, and this reminder: “Revert is available only during this Zotero session.” Calculate savings from the original and installed output sizes. Successful Revert confirms that the original PDF was restored. Success and no-benefit results dismiss after 10 seconds measured from when the result becomes visible. Failures and blocked-action results remain until dismissed.

## Actions and confirmations

Offer Compress and Revert for an eligible single PDF attachment, even when an action is currently unavailable. Explain the reason when invoked; do not silently disable these actions. Do not offer this interface for multiple selections or non-PDF items.

Neither Compress nor safe Revert asks for routine confirmation. Revert blocked by changed attachment bytes or a changed resolved path has no override. File safety, session state, and backup handling follow the [session backup decision](https://github.com/atsyplenkov/zotero-mupdf-compress/issues/6#issuecomment-6465209869) and the attachment replacement decisions in [#3](https://github.com/atsyplenkov/zotero-mupdf-compress/issues/3).

## Outcome messages

Messages must state whether the operation changed the attachment and provide a useful next step where one exists. Suggested wording below describes the outcome; exact punctuation and size formatting can follow the chosen Zotero UI API.

| Outcome | Feedback |
| --- | --- |
| Successful Compress | “Compressed: {original size} to {final size}. Saved {bytes} ({percent}%). Revert is available only during this Zotero session.” |
| Successful Revert | “Original PDF restored.” |
| Valid output with no size benefit | “No smaller PDF produced. The attachment was not changed.” Auto-dismiss after 10 seconds. |
| Invalid output or failed validation | “Compressed output could not be validated. The attachment was not changed.” Keep visible. |
| Missing attachment file | “The attachment file could not be found. Locate it in Zotero and try again. The extension did not change the attachment.” |
| Attachment open in the reader | “Close this PDF in the Zotero reader and try again. The attachment was not changed.” |
| Busy attachment | “An operation is already running for this attachment. Wait for it to finish.” Do not claim that the running operation left the attachment unchanged. |
| Compress after a successful Compress | “This attachment is already compressed in this session. Revert before compressing again. This action did not change the attachment.” |
| Bundled engine unavailable or failed before replacement | “The bundled PDF engine could not run or finish. The attachment was not changed. See the log for technical details.” No suggestion to install an external PDF engine. |
| Backup or temporary-folder failure before replacement | “A verified session backup could not be prepared. The attachment was not changed. Check the temporary folder and try again.” |
| No session Revert record | “Revert is unavailable: no successful compression is recorded for this attachment in this Zotero session. The attachment was not changed.” |
| Missing, unreadable, or corrupt backup | “The session backup is unavailable or could not be verified. The attachment was not changed.” Retain recovery state according to #6; do not promise that retry will succeed. |
| Changed bytes or resolved path blocks Revert | “Revert was blocked because the attachment changed after compression. The extension did not overwrite it.” No force-overwrite control. |
| Attachment changed while Compress was running | “The attachment changed during compression. The extension did not replace it.” |
| Failure after file replacement | Explicitly state that the PDF was replaced or restored but the remaining operation failed. Report the verified state and retained recovery information; never say “the attachment was not changed” or report full success. |
| Replacement failure with uncertain file state | “The operation failed during file replacement. The attachment's current state could not be verified. See the log for technical details.” Do not claim successful replacement or unchanged bytes without verification. |

Keep failure explanations concise. Log the technical stage, error, and sanitized engine diagnostics needed for investigation, without PDF contents. Omit diagnostic text that cannot safely be separated from document content. Do not copy raw engine output into the result window; diagnostics may contain document text. No additional settings, batch controls, automatic retries, or recovery overrides are introduced here.

## Prototype acceptance checks

- Exercise every outcome above for one attachment and verify that its message agrees with the file state.
- Confirm that progress stays non-modal and uses named stages without a percentage estimate or cancellation control.
- Dismiss a running window and verify that work continues and its result reopens. Confirm that a repeated action cannot interrupt the running operation.
- Verify original/final sizes and savings against file sizes, and check the session-only reminder after successful Compress.
- Confirm the 10-second dismissal for success and no-benefit results, and that failures and blocked actions remain until dismissed.
- Verify both actions remain available for an eligible single PDF, explain unavailable states, and require no routine confirmations. Changed-file Revert must have no override.
- Confirm that raw diagnostics and PDF contents are absent from result messages, and PDF contents are absent from logs.
- Exercise partial failures after replacement; messages must not falsely report unchanged bytes or completed success.

These are acceptance checks for [#9](https://github.com/atsyplenkov/zotero-mupdf-compress/issues/9), not results from a running extension.
