---
name: search-endpoints
description: Add or update the server search endpoints behind the Orbis site search. Use when adding or changing content people could look up by name or text, adding searchable fields, or changing who can see existing content.
---

# Search Endpoints

The web app has one search modal for the whole site (see the `search-updates` skill in the web app). These endpoints feed it:

| What | Endpoint | Handler |
| --- | --- | --- |
| Posts everywhere | `GET /feed/search` | `PostsService.searchFeed` |
| A community's posts | `GET /communities/:communityId/posts/search` | `PostsService.searchCommunity` |
| A profile's posts | `GET /users/:username/posts/search` | `PostsService.searchProfile` |
| People | `GET /friends/search` | `FriendsService.search` |
| Communities | `GET /communities/search` | `CommunitiesService.search` |
| Titles | `GET /library/search` | `LibraryService.search` |
| Notifications | `GET /notifications?q=` | `NotificationsService.list` |
| Tickets (site admins only) | `GET /reports/search` | `ReportsService.search` |

## Workflow

1. Find where the content is listed today and apply the same visibility rules, ideally by reusing the same where-clause helpers (`searchFeed` reuses the home feed's `homePosts` and `inMyCommunities`), so search and the listing can't drift apart. Cover:
   - private communities (members only),
   - private profiles (`canViewProfile`),
   - reported or hidden content (`reportedBy` and `visibleTo`),
   - the viewer's NSFW setting (`showsNsfw` and `nsfwEntries`).
2. Trim the query, return nothing under two characters, cap it at 100 characters, match case-insensitively, and limit the number of results (`SEARCH_LIMIT`).
3. Rate-limit the route, for example `@RateLimit(60, MINUTE)`.
4. Add tests: a short query returns nothing without querying the database, and the filters match the listing's rules.
5. Update the web side in the same change, following the web app's `search-updates` skill.
