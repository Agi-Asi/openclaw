# Composer bench iteration ledger

Local-only working ledger. Re-read after every implementation block; move an item to Done only after served DOM, computed style, or source proof.

## In progress

- [x] Keep all four New target triggers visually hovered while their corresponding picker is open.
- [x] Move New Draft beside Permission on the left and reveal it only on footer hover or keyboard focus.
- [x] Brighten model, effort, and Draft icon/text on hover; match Draft icon scale and resting color to Permission.
- [x] Refactor the bench controls exactly to composer-bench-refactor.md: compact control taxonomy, conditional rows, collapsed Composer-selectable group, and narrative scenario rail.

- [x] Move the real Plan card out of the composer interior into a centered floating bubble above Queue and Composer; expand upward into a clean queue-styled plan panel.
- [x] Plan chip previews its real steps on hover; only its expand icon pins and unpins the expanded panel.
- [x] Composer sheets always stack above the sibling Plan chip and Queue surface.
- [x] Slash-command and skills sheets use the body font and one shared hierarchy: muted icon, clean command or skill name, then its adjacent description.
- [x] Microphone and chevron keep separate hitboxes but share one hover ground.
- [x] Permission shortcuts move to the right; selected option shows only the check, never its shortcut.
- [x] Permission modes use coherent icons, and the active mode reuses its option icon in the composer trigger.
- [x] Composer-owned dropdowns in Chat and New share typography, structure, muted icons, internal padding, and pointer-open focus behavior.
- [x] Queue Steer action uses arrow-up instead of the curved corner arrow.
- [x] Queue trash and More icons have balanced visual weight.
- [x] Queue removes the separate grabber column and uses each row's own state icon as the drag/keyboard handle.
- [x] Queue outer border matches the composer and internal dividers are quieter.
- [x] Queue editing has no composer indicator and no Editing badge.
- [x] Queue editing tint does not change on hover.
- [x] Pointer-opened queue editor has no red focus ring; keyboard-opened editor keeps the focus ring.
- [x] Queue edit textarea grows with multiline content up to its internal cap.
- [x] Increase the composer attachment plus icon again without changing its button box.
- [x] Browser annotation uses the compact file-attachment component scale, no filled card background, and omits the redundant "Element inspected" line.
- [x] A steered queue item uses the brand color, keeps only the compact Steering badge, and does not repeat the Steer CTA.
- [x] Confirm from the real queue seam whether deleting a steered item cancels/removes it, then preserve that existing behavior.
- [x] Queue edit mode selector typography and height match the compact queue action scale.
- [x] Remove the synthetic Uploading attachment card: the real owner exposes only a pending-read submit gate and live-region status, not a visual attachment before FileReader completion.
- [x] Attachment menu removes the dead right gutter; options consume the menu width coherently.
- [x] Remove the disposable red send-button refraction decoration from the composer corner.
- [x] Move capability session-override summary out of the composer footer into the capabilities menu; keep only a quiet status cue on the + trigger if needed.
- [x] Selected-skill chip icon matches the text size and keeps a deliberate gap from its label.
- [x] A committed steer row labels its compact badge "Steering" rather than the action verb "Steer".
- [x] File attachment name/type groups are optically centered with equal vertical breathing room.
- [x] Queue edit textarea shows no scrollbar until content actually exceeds its internal height cap.
- [x] Queue edit textarea grows to at most five text lines before internal scrolling.
- [x] Mic + chevron and model + reasoning use two-level hover: shared group ground plus a distinct hovered inner slot.
- [x] Realtime Talk camera preview stays real but floats centered above the composer with elevation instead of consuming its internal layout.
- [x] Composer aggressive minimum footer state activates only under genuinely tight widths; 640px keeps the regular footer and 360px remains collision-free.
- [x] Permission trigger icon is optically centered inside its compact circular slot.
- [x] Permission shortcut numbers align vertically with the selected-row check.
- [x] Footer context, model, and reasoning controls use the same muted hierarchy as the guardian control.
- [x] Replace the awkward Guarded hand glyph with a coherent existing icon and mirror it in the trigger.
- [x] Selected-skill token keeps a visibly rendered gap between its icon and label.
- [x] Selected-skill references are atomic caret units: pointer and arrow navigation cannot stop inside a rendered skill token, while the canonical draft string remains unchanged.
- [x] Bring the existing tasks/plan panel into the bench through its real state seam, with only platform-supported states and behavior.
- [x] Session overrides add a quiet brand dot to the + trigger and render as the final root-menu row in brand color.
- [x] While editing a queued item, the second pointer click outside that item cancels the edit; interactions inside the row do not advance the counter.
- [x] Pointer-opened composer dropdowns may restore functional focus but never paint a focus ring; Tab/keyboard navigation keeps the ring.
- [x] Capability root-menu options consume the full internal width with aligned icon, label, and trailing detail; no dead right gutter.
- [x] Reasoning selection is actionable in the bench and mirrors the real picker state bidirectionally.
- [x] Fast mode is actionable in the bench, its switch geometry is coherent, and its subtitle is short without becoming ambiguous.
- [x] Running uses the established soft-danger Stop treatment instead of the neutral white control.
- [x] Audit the current OpenClaw queue owner and document exactly when a message queues, steers, and which modifiers alter delivery.
- [x] Re-audit the real composer owner and its current neighbors against the bench after Tasks/Plan was found missing: Question, replacement banners, Plan, Queue, Goal, alerts, reply, compaction, fallback, attachments, camera, offline, Tasks, and New targets all route through current platform seams.
- [x] Neutralize MIME attachment icons, then send the preserved eight-color palette to Telegram `avisa-victor` for possible restoration.
- [x] Keep bench disclosure menus open after choosing an option so adjacent states remain available for rapid iteration.
- [x] Keep both scenario-rail arrows at fixed positions across every scenario label and width so repeated navigation never moves the pointer target.
- [x] Add bidirectional top/bottom scroll fades to the bench panel only when more controls exist beyond the current scroll position.
- [x] Match Browser annotation attachment border exactly to the standard file attachment border.
- [x] Move composer error, info, and warning surfaces to the same bottom-underlap stack used by Offline, preserving semantic tones and ordered coexistence.
- [x] Make the Offline underlap span the full composer width, matching the error surface geometry.
- [x] Reduce queue-row copy by 1–2px while preserving the desktop two-line and mobile one-line truncation contract.
- [x] Let `<` and `>` keys move through bench scenarios for rapid keyboard sweeps, in addition to the existing arrow-key navigation.

## Done

- [x] Skill query matches inherit the row typography without browser-default yellow highlighting.
- [x] Model and reasoning remain right-anchored at 360px, 390px, and 640px.
- [x] Microphone input selector remains visible on non-hover devices without auto-opening its menu.

## In progress

- [x] Keep rendered skill references atomic for pointer placement and clean under native selection.
- [x] Close composer sheets and pickers on outside interaction or Escape in Chat and New.
- [x] Reduce the shared hover ground behind model/reasoning and microphone groups.
- [x] Hide the context percentage only in the genuinely narrow mobile footer and balance its lead controls.
- [x] Reveal the Plan expand icon only on hover, keyboard focus, or touch input.
- [x] Rename the model footer provenance to the friendlier “This session only”.
- [x] Align the real background-task status row to the composer owner width in the bench.
- [x] Compact the model picker while expanding its bench catalog with real provider-shaped entries.
- [x] Rebuild the composer plus menu so every row owns the full clean menu width without a dead right gutter.
- [x] Move slash-command and skill descriptions to the trailing edge of their rows.
- [x] Carry the real approval mode picker into New and submit the selected mode through sessions.create.
- [x] Add Hold to dictate to Chat's microphone picker using the existing composerHoldToRecord preference; keep New dictation-only.
- [x] Keep approval, model, visibility, and send collision-free in the genuinely narrow New footer.
- [x] Standardize the microphone preference switch with Fast mode and tighten its picker hierarchy.
- [x] Recompose Effort and make Fast mode's optimistic active paint immediate under hover.
- [x] Refactor active dictation as a reduced composer mode with a moving brand edge, visible level activity, and only stop/accept actions in the footer.
- [x] Fade and blur New recents before their layout collapses.
- [x] Left-align the Plan chip and neutralize the Reply context row.
- [x] Neutralize Goal and compose Plan, Queue, Goal, alerts, and Composer as one ordered stack.
- [x] Pin the bench controls to a stable top-right inset instead of vertically centering them between scenario heights.
- [x] Standardize the real composer and New-session popovers to one structural system: permission, model, effort, context, agent, microphone, environment, worktree, and project.
- [x] Make `<` and `>` advance bench scenarios reliably from the page without stealing text-entry keys.
- [x] Move Width and Theme management to the top-left of the bench panel.
- [x] Close the visible seam in lower composer alerts and deepen their underlap behind the composer.
- [x] Keep Draft fully visible and optically stationary across resting and hover states.
- [x] Suppress option focus rings for every pointer-opened composer picker while preserving keyboard focus-visible behavior.
- [x] Keep model metadata such as `1M` inline with the model name to reduce unnecessary row height.
- [x] Replace the Plan activity glyph with the canonical spinner, slow it down, neutralize progress, shorten the expanded card, synchronize Step counts, and center the chip.
- [x] Default the bench to Desktop width and clear New composer content when switching surfaces.
- [x] Keep Draft visible after activation instead of returning it to hover-only disclosure.
- [x] Increase the Incognito dashed-frame contrast slightly.
- [x] Fix the spacing between Width and Theme in the top-left view dock.
- [x] Disable bench controls whose axes cannot affect the currently rendered surface or state.
- [x] Remove Plan pinning and its expand icon; retain hover preview and completion color only inside the plan steps.
- [x] Show the active Plan step and its 2/3 position in the chip, swapping the resting marker for a spinner only on hover.
- [x] Align the Plan step label and 2/3 counter, and keep its canonical spinner active across the full hover preview.
- [x] Keep the active Plan spinner visible but paused until hover; replace it with a check and the final step plus 3/3 when complete.
- [x] Keep the active Plan spinner rotating continuously, independent of hover.
- [x] Keep bottom error and status underlaps behind the composer footer and send action.
- [x] Normalize all in-scope Above composer neighbors to the real composer width and flow.
- [x] Vertically center every lower composer status band and soften info, danger, and offline borders.
- [x] Show the canonical reconnect pill on every queued row while offline.
- [x] Match running tasks to Plan/composer chrome and share one horizontal status row when both appear.
- [x] Move the scenario sweep into the top rail between the view card and Composer controls.
- [x] Default Width to Desktop and let its endpoint fill the available bench stage.
- [x] Center lower status-band content within the visible area below the composer.
- [x] Standardize the three bench shells to one background, border and radius.
- [x] Start the options panel directly at Composition without a title separator.
- [x] Cap attached queues at three rows and provide a six-item scroll fixture with a top overflow fade.
- [x] Make attached queue and goal chrome span the full composer width.
- [x] Use the success token for the completed Plan pill check.
- [x] Keep failed queue actions on the primary row and move the delivery-state pill before the diagnostic copy.
- [x] Enforce one precedence-ordered composer status lane and keep Interrupted with its assistant turn.
- [x] Add Interrupted + members, offline + read-only and approval + offline sweep fixtures.

## Observed queue contract

- Appearance > Chat > Follow-ups while the agent is working owns the explicit browser choice: Server default, Steer into the active run, or Queue until the run ends.
- Every Control UI send is staged in the outbox first; it only remains visibly queued while delivery is blocked, waiting for the active run, reconnecting, waiting for model setup, being edited, or failed.
- With Queue selected during an active run, an ordinary send remains FIFO until that run ends. With Steer selected, the fresh message is admitted to the active run and may bypass older FIFO rows.
- When the send shortcut is Enter and Queue is selected, Enter queues while Command/Ctrl+Enter explicitly steers. Shift+Enter remains a newline; Alt prevents the force-steer modifier path.
- There is no inverse modifier that forces Queue while Steer is selected; Queue is activated through the preference (or inherited server/session mode).
- Empty Enter during an active run steers the oldest eligible visible row. Each eligible row also exposes a Steer action.
- A steered row can still be removed while it remains in the local queue; editing and reorder follow the owner locks for in-flight or otherwise non-movable rows.
