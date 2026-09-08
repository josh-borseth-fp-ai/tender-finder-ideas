# Tender Finder

A person pastes the address of a public procurement site and collects the open opportunities listed there, taking over the hosted browser when the site demands a human.

## Language

**Source URL**:
The http(s) address a person pastes to start a Crawl. It may be any page on a public procurement site.
_Avoid_: portal, target, seed

**Solicitation index**:
The page that enumerates currently open Solicitations.
_Avoid_: bids page, listing page, portal, RFP list

**Crawl**:
One attempt to collect open solicitations from a single Source URL.
_Avoid_: job, run, scrape, task

**Solicitation**:
An open government contract opportunity listed on a Solicitation index.
_Avoid_: RFP, tender, bid, listing, opportunity

**Access wall**:
A login, captcha, or other human gate that stops a Crawl until a person acts in the hosted browser.
_Avoid_: block, challenge, auth, captcha (as the general term)

**Live view**:
The interactive Browserbase window for the hosted browser of a Crawl.
_Avoid_: debugger, iframe, session viewer
