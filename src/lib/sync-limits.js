/**
 * How much one sync request carries.
 *
 * A push sends each pack as one GraphQL commit (kvgit's `PackRemote`),
 * and GitHub's GraphQL endpoint gives up on a request whose body hasn't
 * fully arrived after about five seconds. It answers 499 without CORS
 * headers, which a browser reports as a network failure ("GitHub
 * couldn't be reached"), and every retry sends the same body again. So
 * the limit is time, not size: how much fits depends on the connection's
 * upload speed, about 9 MB at 15 Mbit/s and 3 MB at 5.
 *
 * A pack gathers at most `PACK_BYTES` of values. Compressed and in
 * base64 that is at most about 2.7 MiB, a couple of seconds on a modest
 * connection. A single commit larger than this is still one pack, sent
 * in one request, so whatever writes large commits on purpose (a
 * snapshot, `snapshot.js`) splits them to this size.
 */
export const PACK_BYTES = 2 * 1024 * 1024;
