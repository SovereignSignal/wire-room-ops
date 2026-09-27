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
