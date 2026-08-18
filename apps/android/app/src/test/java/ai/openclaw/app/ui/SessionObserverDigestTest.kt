package ai.openclaw.app.ui

import ai.openclaw.app.chat.ChatSessionAgentStatus
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.chat.applySessionObserverDigest
import ai.openclaw.app.chat.mergeChatSessionEntry
import ai.openclaw.app.chat.reconcileGlobalObserverDigestOwner
import ai.openclaw.app.chat.reconcileSessionObserverProjectionOwner
import ai.openclaw.app.gateway.SessionObserverDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SessionObserverDigestTest {
  @Test
  fun observerEventsCarryTheirRunAndAdvanceMonotonically() {
    val running =
      ChatSessionEntry(
        key = "agent:main:work",
        updatedAtMs = 100,
        hasActiveRun = true,
        status = "running",
      )
    var sessions =
      applySessionObserverDigest(
        listOf(running),
        digest(runId = "run-1", revision = 2, updatedAt = 200, headline = "Second"),
        authoritativeRunIds = setOf("run-1"),
      )
    sessions =
      applySessionObserverDigest(
        sessions,
        digest(runId = "run-1", revision = 1, updatedAt = 300, headline = "Stale"),
        authoritativeRunIds = setOf("run-1"),
      )
    assertEquals("Second", sessions.single().observerDigest?.headline)
    assertEquals("Second", sessionListSubtitle(sessions.single(), fallback = "Work", nowMs = 1_000))

    val projected =
      ChatSessionEntry(
        key = running.key,
        updatedAtMs = 500,
        observerDigest = digest(runId = "run-1", revision = 3, updatedAt = 500, headline = "Projected"),
        hasObserverDigestMetadata = true,
        hasActiveRun = true,
        hasActiveRunMetadata = true,
        status = "running",
        hasRunMetadata = true,
      )
    assertEquals("Projected", mergeChatSessionEntry(sessions.single(), projected).observerDigest?.headline)
  }

  @Test
  fun delayedPredecessorObserverDoesNotReplaceTheLocallyOwnedRun() {
    val running =
      ChatSessionEntry(
        key = "agent:main:work",
        updatedAtMs = 100,
        hasActiveRun = true,
        status = "running",
      )

    val sessions =
      applySessionObserverDigest(
        listOf(running),
        digest(runId = "run-predecessor", revision = 2, updatedAt = 200, headline = "Stale"),
        authoritativeRunIds = setOf("run-successor"),
      )

    assertNull(sessions.single().observerDigest)
    assertEquals("Work", sessionListSubtitle(sessions.single(), fallback = "Work", nowMs = 1_000))
  }

  @Test
  fun explicitNullProjectionClearsDigestWhileRunIsActive() {
    val existing =
      ChatSessionEntry(
        key = "agent:main:work",
        updatedAtMs = 100,
        observerDigest = digest(runId = "run-1", revision = 4, updatedAt = 400, headline = "Stale"),
        hasActiveRun = true,
        status = "running",
      )
    val explicitClear =
      ChatSessionEntry(
        key = existing.key,
        updatedAtMs = 500,
        observerDigest = null,
        hasObserverDigestMetadata = true,
        hasActiveRun = true,
        hasActiveRunMetadata = true,
        status = "running",
        hasRunMetadata = true,
      )

    assertNull(mergeChatSessionEntry(existing, explicitClear).observerDigest)
  }

  @Test
  fun globalObserverEventsRequireTheSelectedAgent() {
    val running =
      ChatSessionEntry(
        key = "global",
        updatedAtMs = 100,
        hasActiveRun = true,
        status = "running",
      )
    val wrongOwner =
      SessionObserverDigest(
        sessionKey = "global",
        agentId = "main",
        runId = "run-work",
        revision = 1,
        updatedAt = 200,
        headline = "Wrong owner",
        health = "stuck",
      )
    val selectedOwner = wrongOwner.copy(agentId = "work", headline = "Selected owner")
    val missingOwner = wrongOwner.copy(agentId = null, headline = "Missing owner")

    val rejected = applySessionObserverDigest(listOf(running), wrongOwner, activeAgentId = "work")
    val ownerless =
      applySessionObserverDigest(
        rejected,
        missingOwner,
        activeAgentId = "work",
      )
    val disconnected =
      applySessionObserverDigest(
        listOf(running.copy(observerDigest = wrongOwner.copy(headline = "Last verified owner"))),
        missingOwner,
        activeAgentId = null,
      )
    val accepted =
      applySessionObserverDigest(
        ownerless,
        selectedOwner,
        activeAgentId = "work",
        authoritativeRunIds = setOf("run-work"),
      )

    assertNull(rejected.single().observerDigest)
    assertNull(ownerless.single().observerDigest)
    assertEquals("Last verified owner", disconnected.single().observerDigest?.headline)
    assertEquals("Selected owner", accepted.single().observerDigest?.headline)
  }

  @Test
  fun globalReconnectRejectsForeignAndStaleObserverDigests() {
    val current =
      SessionObserverDigest(
        sessionKey = "global",
        agentId = "work",
        runId = "run-work",
        revision = 4,
        updatedAt = 400,
        headline = "Current work status",
        health = "grinding",
      )
    val running =
      ChatSessionEntry(
        key = "global",
        updatedAtMs = 100,
        hasActiveRun = true,
        status = "running",
        observerDigest = current,
      )

    val foreign =
      applySessionObserverDigest(
        listOf(running),
        current.copy(
          agentId = "main",
          revision = 9,
          updatedAt = 900,
          headline = "Foreign status",
        ),
        activeAgentId = "work",
        authoritativeRunIds = setOf("run-work"),
      )
    val replayed =
      applySessionObserverDigest(
        foreign,
        current.copy(
          revision = 3,
          updatedAt = 1_000,
          headline = "Replayed work status",
        ),
        activeAgentId = "work",
        authoritativeRunIds = setOf("run-work"),
      )

    assertEquals("Current work status", replayed.single().observerDigest?.headline)
    assertEquals(4L, replayed.single().observerDigest?.revision)
  }

  @Test
  fun changingTheSelectedAgentClearsThePreviousGlobalDigest() {
    val previous =
      ChatSessionEntry(
        key = "global",
        updatedAtMs = 100,
        hasActiveRun = true,
        status = "running",
        observerDigest =
          SessionObserverDigest(
            sessionKey = "global",
            agentId = "main",
            runId = "run-main",
            revision = 4,
            updatedAt = 400,
            headline = "Main owner",
            health = "on-track",
          ),
      )

    val switched =
      reconcileGlobalObserverDigestOwner(
        listOf(previous),
        activeAgentId = "work",
        adoptOwnerless = false,
      )
    val ownerless =
      reconcileGlobalObserverDigestOwner(
        listOf(previous.copy(observerDigest = previous.observerDigest?.copy(agentId = null))),
        activeAgentId = "work",
        adoptOwnerless = false,
      )
    val disconnected =
      reconcileGlobalObserverDigestOwner(
        listOf(previous),
        activeAgentId = null,
        adoptOwnerless = false,
      )

    assertNull(switched.single().observerDigest)
    assertNull(ownerless.single().observerDigest)
    assertEquals("Main owner", disconnected.single().observerDigest?.headline)
  }

  @Test
  fun globalSessionProjectionRequiresMatchingOuterAndDigestOwners() {
    val projected =
      ChatSessionEntry(
        key = "global",
        updatedAtMs = 900,
        ownerAgentId = "work",
        status = "running",
        observerDigest =
          SessionObserverDigest(
            sessionKey = "global",
            agentId = "main",
            runId = "run-main",
            revision = 9,
            updatedAt = 900,
            headline = "Foreign owner",
            health = "stuck",
          ),
      )

    val mismatched = reconcileSessionObserverProjectionOwner(projected, ownerAgentId = "work")
    val legacy =
      reconcileSessionObserverProjectionOwner(
        projected.copy(observerDigest = projected.observerDigest?.copy(agentId = null)),
        ownerAgentId = "work",
      )

    assertNull(mismatched.observerDigest)
    assertEquals("running", mismatched.status)
    assertEquals("work", legacy.observerDigest?.agentId)

    val scopedLegacy =
      reconcileGlobalObserverDigestOwner(
        listOf(projected.copy(observerDigest = projected.observerDigest?.copy(agentId = null))),
        activeAgentId = "work",
      )
    assertEquals("work", scopedLegacy.single().observerDigest?.agentId)
  }

  @Test
  fun subtitlePrecedenceAndUnreadFinalRuleMatchTheWebSidebar() {
    val liveDigest = digest(runId = "run-1", revision = 1, updatedAt = 200, headline = "Observer")
    val agentStatus = ChatSessionAgentStatus(note = "Agent note", expiresAt = 10_000)
    val failed =
      ChatSessionEntry(
        key = "work",
        updatedAtMs = 500,
        lastReadAt = 100,
        agentStatus = agentStatus,
        observerDigest = liveDigest,
        observerDigestRunIsAuthoritative = true,
        hasActiveRun = true,
        status = "failed",
        lastRunError = "Needs approval",
        endedAt = 500,
      )

    assertEquals("Needs approval", sessionListSubtitle(failed, fallback = "Work", nowMs = 1_000))
    assertEquals(
      "Agent note",
      sessionListSubtitle(failed.copy(status = "running", lastRunError = null), fallback = "Work", nowMs = 1_000),
    )
    assertEquals(
      "Waiting for a concurrency slot",
      sessionListSubtitle(
        failed.copy(agentStatus = null, status = "queued", lastRunError = null),
        fallback = "Work",
        nowMs = 1_000,
      ),
    )

    val finalDigest = digest(runId = null, revision = 2, updatedAt = 2_000, headline = "Finished", health = "done")
    val idle = ChatSessionEntry(key = "work", updatedAtMs = 2_000, lastReadAt = 1_999, observerDigest = finalDigest)
    assertEquals("Finished", sessionListSubtitle(idle, fallback = "Work", nowMs = 3_000))
    assertEquals("Work", sessionListSubtitle(idle.copy(lastReadAt = 2_000), fallback = "Work", nowMs = 3_000))
  }

  private fun digest(
    runId: String?,
    revision: Long,
    updatedAt: Long,
    headline: String,
    health: String = "on-track",
  ): SessionObserverDigest =
    SessionObserverDigest(
      sessionKey = "agent:main:work",
      runId = runId,
      revision = revision,
      updatedAt = updatedAt,
      headline = headline,
      health = health,
    )
}
