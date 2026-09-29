// supabase/functions/accept-invite/index.ts
//
// Called by accept-invite.html once someone has set a password. Creates
// their Supabase Auth user and their `staff` row from the invite's role,
// org, and department — then marks the invite as accepted so the link
// can't be reused. Requires the service-role key, so this must run here,
// never in client-side JS.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid request body.' }, 400);
  }

  const token = body.token;
  const fullName = body.full_name;
  const password = body.password;

  if (!token || !fullName || !password) {
    return jsonResponse({ error: 'Missing token, full_name, or password.' }, 400);
  }
  if (password.length < 8) {
    return jsonResponse({ error: 'Password must be at least 8 characters.' }, 400);
  }

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );

  // 1. Look up the invite by token (bypasses RLS — service role).
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

  // 2. Create the auth user. Email is pre-confirmed since it came from a
  //    trusted invite the admin sent, not a public signup.
  const createResult = await supabaseAdmin.auth.admin.createUser({
    email: invite.email,
    password: password,
    email_confirm: true
  });

  if (createResult.error || !createResult.data.user) {
    // Most common cause: an account with this email already exists.
    var msg = (createResult.error && createResult.error.message) || 'Could not create account.';
    return jsonResponse({ error: msg }, 400);
  }
  var newUser = createResult.data.user;

  // 3. Create the staff row using the invite's role/org/department.
  const staffResult = await supabaseAdmin.from('staff').insert({
    user_id: newUser.id,
    org_id: invite.org_id,
    department_id: invite.department_id,
    role: invite.role,
    full_name: fullName,
    is_active: true
  });

  if (staffResult.error) {
    // Roll back the auth user so a failed invite never leaves an orphaned
    // login with no matching staff record.
    await supabaseAdmin.auth.admin.deleteUser(newUser.id);
    return jsonResponse({ error: 'Could not finish setting up your account: ' + staffResult.error.message }, 500);
  }

  // 4. Mark the invite accepted so the link can't be reused.
  await supabaseAdmin.from('invites').update({ status: 'accepted' }).eq('id', invite.id);

  return jsonResponse({ success: true, role: invite.role, email: invite.email }, 200);
});
