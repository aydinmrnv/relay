/** The document workflow. */

export function transition(state, event) {
  if (state === 'draft') {
    if (event === 'submit') return 'review';
    if (event === 'discard') return 'discarded';
  } else if (state === 'review') {
    if (event === 'approve') return 'approved';
    if (event === 'reject') return 'draft';
    if (event === 'discard') return 'discarded';
  } else if (state === 'approved') {
    if (event === 'publish') return 'published';
    if (event === 'reject') return 'draft';
  } else if (state === 'published') {
    if (event === 'archive') return 'archived';
  }

  throw new Error(`cannot ${event} from ${state}`);
}
