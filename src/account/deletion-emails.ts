import { emailHtml } from '../common/email-layout';
import { webUrl } from '../common/web-url';

const dateFormat = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'long',
  timeStyle: 'short',
  timeZone: 'UTC',
});

export function deletionScheduledEmail(deleteAt: Date) {
  const subject = 'Your Orbis account is scheduled for deletion';
  const date = `${dateFormat.format(deleteAt)} UTC`;
  const link = `${webUrl()}/login`;
  const body = `Your Orbis account will be deleted on ${date}, along with your posts, comments, messages, library, and everything else in it. Changed your mind? Sign in before then and your account stays just as it is.`;
  const footer =
    'If you didn’t ask for this, sign in now to cancel it and keep your account safe.';
  return {
    subject,
    text: `${body}\n\nSign in to cancel: ${link}\n\n${footer}`,
    html: emailHtml({
      title: subject,
      preview: `Sign in before ${date} to keep your account.`,
      heading: 'Your account will be deleted',
      body,
      button: { label: 'Sign in to cancel', link },
      footer,
    }),
  };
}

export function deletionCancelledEmail() {
  const subject = 'Your Orbis account deletion was cancelled';
  const link = webUrl();
  const body =
    'You signed back in, so your Orbis account won’t be deleted. Everything is just as you left it.';
  const footer =
    'If this wasn’t you, check your sign-in settings in Orbis right away.';
  return {
    subject,
    text: `${body}\n\nOpen Orbis: ${link}\n\n${footer}`,
    html: emailHtml({
      title: subject,
      preview: 'Your account is staying.',
      heading: 'Welcome back',
      body,
      button: { label: 'Open Orbis', link },
      footer,
    }),
  };
}
