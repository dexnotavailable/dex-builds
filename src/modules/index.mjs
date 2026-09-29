// Order matters only for start(): earlier modules start first.
import provision from './provision.mjs';
import admin from './admin.mjs';
import status from './status.mjs';
import onboarding from './onboarding.mjs';
import access from './access.mjs';
import feed from './feed.mjs';
import activity from './activity.mjs';
import deploys from './deploys.mjs';
import digest from './digest.mjs';
import source from './source.mjs';
import worktree from './worktree.mjs';
import review from './review.mjs';
import feedback from './feedback.mjs';

export const modules = [provision, admin, status, onboarding, access, feed, activity, deploys, digest, source, worktree, review, feedback];
