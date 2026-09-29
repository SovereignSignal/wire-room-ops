# Automatic organization identity guard

Program titles are discovery evidence. They must not automatically create or select an organization profile. The automatic guard covers program/programme titles, grant and scholarship offerings, research awards, cohorts, hackathons, fellowships, incubators and bug bounties. Rejected names stay unresolved for review; the guard does not guess an owner by stripping words.

The guard applies to pattern and model extraction, direct profile upsert, the profile selected by exact-name/recorded-alias lookup, and the final automatic entry link. Enrichment fields do not establish identity. A legacy program profile therefore cannot become eligible just because it has a website, description or organization type. An exact rejected profile also cannot silently fall through to another organization's alias.

Known title prefixes can still identify their existing canonical organization, such as Google Research Scholar Program resolving to Google. An explicit recorded alias may identify a genuine organization; the selected profile itself must pass the program-name guard. Existing non-program funds and DAOs remain eligible. These exact names are intentional exceptions:

- United Nations Development Programme: its [official description](https://www.undp.org/about-us) identifies the UN development agency.
- Zcash Community Grants: its [official selection process](https://zcashcommunitygrants.org/selection/) identifies the committee making grant decisions.
- AI Grant: its [official grant site](https://aigrant.org/) presents the established funding identity. Preserve this existing identity without inferring a different legal parent or merging its accelerator and grant records.

These exceptions do not generalize to arbitrary similarly named organizations. New ambiguous names need review. The name screen is deliberately conservative, not proof of legal identity or a universal natural-language classifier.

Automatic linking locks and re-reads the entry before writing. An existing organization link or an operator hold wins, including a decision committed while extraction waits. Skipped links do not trigger organization enrichment or count as successful links. An error still rolls back entry and program linking together.

The historical cleanup classifier and archive rules remain unchanged. A name rejected for new automatic linking does not authorize deletion, reparenting, relinking or archiving existing records. This release needs no schema migration, data backfill or new schedule. It uses schema version 2 and the existing restricted runtime role.

## Ambiguous Base names and verified program owners

Bare `Base` and `BASE` no longer normalize to Coinbase. Capitalization is not
identity evidence: the [BASE fellowship](https://www.baseresearch.org/base-fellowship-f26)
belongs to Black in AI Safety & Ethics. Unrecognized titles beginning with Base
stay unresolved and are excluded from model fallback. Explicit `Base (Coinbase)`
and the verified [Base Batches](https://www.base.org/batches) and
[Base Ecosystem Fund](https://www.base.org/ecosystem-fund) titles still resolve
to the Coinbase ecosystem profile. Other Base offerings need review, even if
some ultimately belong to Coinbase. The existing bare BASE profile is preserved
for historical review and cannot be selected automatically by name or ID.

Two additional verified title prefixes resolve to their owners:

- [BNB Hack](https://www.bnbchain.org/en/blog/bnb-hack-college-edition-now-live)
  resolves to BNB Chain.
- [Acquia Fair Trade Initiative](https://www.acquia.com/partners/fair-trade-initiative)
  resolves to Acquia.

These are title-to-owner relationships, not organization aliases. Direct profile
creation, exact-name lookup, alias selection, and final linking reject the
program profiles themselves, including enriched legacy profiles. This targeted
list does not reject unrelated organizations named Hack Club or Community
Initiatives, or change historical archive classification.

Final linking checks the current locked entry title as well as the selected
profile. A changed title requiring Base review cannot use a stale extraction
result. Existing links and operator holds still take precedence. Model results
for entries outside the submitted chunk are ignored so they cannot bypass an
excluded identity review. No schema change, data rewrite, provider run, or
schedule change is required by this fix.

Crypto World's Fair is a Colosseum event, including its regional tracks. Title extraction maps straight and curly apostrophe spellings to Colosseum; event profiles remain excluded from automatic reuse. Source: https://colosseum.com/worldsfair. This owner mapping does not certify track prize or eligibility details.

## Reviewed organization coverage and review holds

Approval-time extraction also recognizes these existing organization identities:
[Prezenti](https://www.prezenti.xyz/), [Nebius](https://dev.nebius.com/builders),
[FLOSS/fund](https://floss.fund/), [Unitary Foundation](https://unitary.foundation/grants/),
[Funding the Commons](https://www.fundingthecommons.io/),
[Foresight Institute](https://foresight.org/grants/ai-science-safety-nodes-rfp/), and
[BlueDot Impact](https://bluedot.org/programs/incubator-week).
Their complete names must occur at the existing title boundary. This does not
infer owners from arbitrary domains or similar profile names.

The [PL Research Grant Program](https://research.protocol.ai/categories/grants/index.html)
is a verified Protocol Labs offering. It resolves at title extraction, while the
program name remains ineligible as an organization profile.

Entry and program linking both preserve the recorded `Human review required`
marker, as well as `decided_recheck.canonical_parent_blocked` and
`decided_recheck.cross_wire_blocked`. These structured review blocks must not
be bypassed just because the notes omit the literal word `HOLD`. Resolved links
and existing holds still take precedence. Historical repairs require separate
review; this code change does not run extraction, start paid calls, or schedule
backfills.

Program matching also excludes social, event, form, recruitment and shared
publishing hosts from organization-domain evidence. Two posts on X do not imply
one operator. Generic token overlap requires supporting organization agreement
or a first-party domain; exact program keys and recorded aliases still work
within the other identity guards. This prevents new shared-host conflation but
does not certify existing aliases or repair previously mixed program groups.

Recorded program aliases come from sightings and can contain old mistakes.
Without organization/domain support, an alias must also share a distinctive
word with the canonical title. Generic words such as "community", "open source"
and "fellowship" cannot legitimize an unrelated alias. This deliberately leaves
unsupported renamed programs for review; independently supported renames remain
matchable. It does not edit the stored historical aliases.
