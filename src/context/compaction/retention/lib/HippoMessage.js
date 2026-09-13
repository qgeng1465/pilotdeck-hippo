/**
 * The message shape this package scores.
 *
 * Deliberately a *minimal structural supertype* of the host application's
 * message type rather than a copy of it: everything declared here is optional
 * or wider, so any host message that carries a role, a content-block array and
 * an optional metadata bag is accepted without an adapter — while this file
 * keeps zero imports, which is what lets the package be installed on its own.
 *
 * Only `role`, `content`, and the two metadata flags below are ever read by the
 * scoring policy. Everything the policy does not look at (provider reasoning
 * signatures, tool-call raw payloads, persisted-result paths, MIME details) is
 * intentionally absent here so the contract stays as small as the code's needs.
 */
export {};
