# After harvest, the model judges remainder and cause

Harvest still stops when this query’s pages end. A following structured call looks at the harvest counts and the page snapshot and says whether this session collected what it can, in its own words. Code does not parse advertised totals or assume login. A human pause happens only when the judgment says login would unlock more and this crawl has not already paused for sign-in. Other remainders keep the reason and continue.
