## Issue Management

 * Unlabelled issues query should be checked daily and driven as close to zero as practical
   * **Action**: Add a coherent set of labels to all issues
   * **On track**: Less than ~30 at all times; oldest unlabelled issue should be less than 2 weeks old.
 * Unmilestoned bugs should be managed starting about a month before release
   * **Action**: Assign a milestone to every Bug-tagged issue
   * **On track**: Less than 5 if past the midpoint of a release cycle
 * Unassigned bugs in the current milestone should always be zero
   * **Action**: Assign to a dev on the team with available capacity
   * **On track**: Zero
 * Unassigned "other" in the current milestone: 
  * **Action**: Investigate (these are usually "special" and need planning work done)
  * **On track**: Less than 5
   
## Release Cycle

 * Ongoing: Check each person's total active bug count in the current and next milestones; rebalance if needed
 * ~2 week before release, make a release branch, drive active bugs in release to zero
 * Release RC once there are no remaining "big" issues

## Suggestions

 * **Don't** just put `Suggestion` on a query (see "Debt" below). Must have a sublabel:
   * `In Discussion`: Ready for analysis on our side
   * `Needs Proposal`: Has a worthwhile goal but doesn't outline how that would be accomplished
   * `Needs More Info`: Proposal lacks necessary information (usually around use cases)
   * `Too Complex`: Doesn't provide enough value relative to implementation or concept-count cost. Close.
   * `Out of Scope`: Not aligned with our core goals. Close.
   * `Revisit`: Not now but possiby later if something else (usually TC39) changes. Close.
 * As time allows, run a slog
   * Pull ~40 candidates from the Slog Candidate query
   * A suggestion is slog-ready if we can:
     * Accurately describe it in a sentence or two
     * Produce a "yes or no" result with a few small bikeshed decisions
    * Write a single-sentence summary of each candidate. This is to both vet the suggestions for well-formedness and to familiarize yourself with the content
   * **Drive for decisions** in this meeting! There should always be a new concrete next step on each item
 * Interesting suggestions that need more discussion than a slog allows should go to the design meeting

## Debt

 * Needs Investigation: Largely a block of ~200 issues we declared bankruptcy on in mid-2017. "Should" be treated as effectively unlabelled but we've assumed any high-pri issues here have been since re-bubbled.
   * Needs to be handled eventually, but currently the lowest-priority work
 * Needs Sublabel: Issues tagged "Suggestion" without any other label, so we don't know what state they're in.
   * Work on paying this down
   
