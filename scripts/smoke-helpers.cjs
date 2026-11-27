async function waitForSnapshot(page, predicate, timeout = 30000) {
  const deadline = Date.now() + timeout
  let latest
  while (Date.now() < deadline) {
    latest = await page.evaluate(() => window.vinxaPhase2.snapshot())
    if (predicate(latest)) return latest
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(
    'Snapshot condition timed out: ' +
      JSON.stringify({
        state: latest?.state,
        busy: latest?.busy,
        error: latest?.error,
        engine: latest?.engine,
        entries: latest?.segments.length
      })
  )
}
module.exports = { waitForSnapshot }
