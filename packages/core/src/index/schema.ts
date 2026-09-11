/**
 * Phien ban logic trich fact. TANG SO NAY moi khi extractor doi hanh vi —
 * moi ban ghi cu se tu dong bi coi la cu va parse lai.
 *
 * Day la co che duy nhat chong "cache sai" giua cac ban extension. Trong qua
 * trinh phat trien da co dung mot lan quen tang: doi `inferShape` ma khong bump,
 * ket qua la go-to-definition tra ve vi tri cu cho toi khi bump so nay.
 */
export const PARSER_VERSION = 10;

/** Ten file cache trong thu muc .ejsng-cache/ */
export const INDEX_FILENAME = 'index.ndjson';
