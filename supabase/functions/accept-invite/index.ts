// supabase/functions/accept-invite/index.ts
//
// Called by accept-invite.html once someone has set a password. Claims the
// invite, creates the Supabase Auth user and the `staff` row, and returns the
// role so the page can redirect. Needs the service-role key, so it runs here
// and never in client-side JS.
//
// Deploy WITHOUT JWT verification (the invitee has no session yet):
//   supabase functions deploy accept-invite --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405);

  // deno-lint-ignore no-explicit-any
  let body: any;
  try {
    body = await req.json();
  } catch (_e) {
    return jsonResponse({ error: 'Invalid request body.' }, 400);
  }

  const token = body?.token;
  const fullName = typeof body?.full_name === 'string' ? body.full_name.trim() : '';
  const password = body?.password;

  if (typeof token !== 'string' || !token || !fullName || typeof password !== 'string') {
    return jsonResponse({ error: 'Missing token, full_name, or password.' }, 400);
  }
  if (fullName.length > 100) {
    return jsonResponse({ error: 'Name is too long.' }, 400);
  }
  if (password.length < 8 || password.length > 72) {
    return jsonResponse({ error: 'Password must be between 8 and 72 characters.' }, 400);
  }

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );

  // 1. Look up the invite (service role bypasses RLS).
  const inviteResult = await supabaseAdmin
    .from('invites')
    .select('id, org_id, email, role, department_id, status, expires_at')
    .eq('token', token)
    .maybeSingle();

  if (inviteResult.error || !inviteResult.data) {
    return jsonResponse({ error: 'Invite not found.' }, 404);
  }
  const invite = inviteResult.data;

  if (invite.status !== 'pending') {
    return jsonResponse({ error: 'This invite has already been used or revoked.' }, 410);
  }
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
    return jsonResponse({ error: 'This invite has expired. Ask your admin to send a new one.' }, 410);
  }

  // 2. Claim the invite atomically. Only one request can flip pending -> accepted,
  //    so two simultaneous clicks can't both go on to create accounts.
  const claim = await supabaseAdmin
    .from('invites')
    .update({ status: 'accepted' })
    .eq('id', invite.id)
    .eq('status', 'pending')
    .select('id');

  if (claim.error) {
    return jsonResponse({ error: 'Could not process this invite. Please try again.' }, 500);
  }
  if (!claim.data || claim.data.length === 0) {
    return jsonResponse({ error: 'This invite has already been used or revoked.' }, 410);
  }

  // If anything below fails, put the invite back so the person can retry.
  async function releaseInvite() {
    await supabaseAdmin.from('invites').update({ status: 'pending' }).eq('id', invite.id);
  }

  // 3. Create the auth user (email pre-confirmed: it came from an admin's invite).
  const createResult = await supabaseAdmin.auth.admin.createUser({
    email: invite.email,
    password,
    email_confirm: true,
  });

  if (createResult.error || !createResult.data.user) {
    await releaseInvite();
    const code = createResult.error?.code;
    const raw = createResult.error?.message ?? '';
    if (code === 'email_exists' || /already.*(registered|exists)/i.test(raw)) {
      return jsonResponse({
        error: 'An account with this email already exists. Try signing in, or ask your admin for help.',
      }, 409);
    }
    return jsonResponse({ error: raw || 'Could not create account.' }, 400);
  }
  const newUser = createResult.data.user;

  // 4. Create the staff row from the invite's role/org/department.
  const staffResult = await supabaseAdmin.from('staff').insert({
    user_id: newUser.id,
    org_id: invite.org_id,
    department_id: invite.department_id,
    role: invite.role,
    full_name: fullName,
    is_active: true,
  });

  if (staffResult.error) {
    // Roll back so a failed invite never leaves an orphaned login.
    await supabaseAdmin.auth.admin.deleteUser(newUser.id);
    await releaseInvite();
    return jsonResponse({ error: 'Could not finish setting up your account: ' + staffResult.error.message }, 500);
  }

  return jsonResponse({ success: true, role: invite.role, email: invite.email }, 200);
});
