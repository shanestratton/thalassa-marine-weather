// Browser and Edge share the same pure codec through Vercel's existing _shared boundary.
export { jpegSize, readPhotoBody, sanitizeReviewJpeg } from '../_shared/community-review-photo-codec.ts';
export type { JpegCodec, Pixels } from '../_shared/community-review-photo-codec.ts';
