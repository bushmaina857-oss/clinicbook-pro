// ClinicBook Pro — shared session, auth-refresh, and nav module.
// Include this on every staff page BEFORE any page-specific script:
//   <script src="session.js"></script>
//
// What this fixes: previously every page read `access_token` from
// localStorage once at load and never refreshed it. Supabase access
// tokens expire after ~1 hour, so any staff member who kept a tab open
// longer than that started getting silent 401s (e.g. the AI summary
// button, or any REST/RPC call) with no recovery except a manual
// re-login. This module refreshes the token transparently using the
// refresh_token that's already been sitting unused in the stored
// session object, and only forces a re-login if the refresh itself
// fails (refresh tokens last ~30 days idle).

var CB = window.CB = window.CB || {};

CB.SUPABASE_URL = 'https://iyxumauddvmdfbukrzaa.supabase.co';
CB.SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml5eHVtYXVkZHZtZGZidWtyemFhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2NDk5MTUsImV4cCI6MjA5ODIyNTkxNX0.5B2LHcgRdrRrJbrjKWbK-kqUUlHnws7nxl1fNeZrvHE';

CB.session = null;
CB.authHeaders = null;

// ---------------------------------------------------------------------
// SESSION / AUTH
// ---------------------------------------------------------------------

// Call this at the top of any page that requires a signed-in staff
// member. Reads the stored session, redirects to staff-login.html if
// missing, and sets CB.session / CB.authHeaders. Mirrors what each page
// used to do inline.
CB.requireSession = function() {
  var session = null;
  try { session = JSON.parse(localStorage.getItem('clinicbook_pro_session')); } catch (e) {}
  CB.session = session;

  if (!session || !session.access_token) {
    window.location.href = 'staff-login.html';
    return null;
  }

  CB.authHeaders = {
    'apikey': CB.SUPABASE_ANON_KEY,
    'Authorization': 'Bearer ' + session.access_token,
    'Content-Type': 'application/json'
  };
  return session;
};

// Uses the refresh_token already stored alongside access_token (Supabase's
// password-grant response always includes both) to get a fresh access
// token, and persists the new session.
CB.refreshSession = function() {
  if (!CB.session || !CB.session.refresh_token) {
    return Promise.reject(new Error('no_refresh_token'));
  }
  return fetch(CB.SUPABASE_URL + '/auth/v1/token?grant_type=refresh_token', {
    method: 'POST',
    headers: { 'apikey': CB.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: CB.session.refresh_token })
  }).then(function(res) {
    return res.text().then(function(t) {
      var data = {};
      try { data = t ? JSON.parse(t) : {}; } catch (e) {}
      if (!res.ok || !data.access_token) throw new Error('refresh_failed');
      return data;
    });
  }).then(function(data) {
    CB.session = data;
    localStorage.setItem('clinicbook_pro_session', JSON.stringify(data));
    CB.authHeaders = {
      'apikey': CB.SUPABASE_ANON_KEY,
      'Authorization': 'Bearer ' + data.access_token,
      'Content-Type': 'application/json'
    };
    return data.access_token;
  });
};

CB.forceReauth = function() {
  localStorage.removeItem('clinicbook_pro_session');
  window.location.href = 'staff-login.html';
};

CB.logout = function() {
  localStorage.removeItem('clinicbook_pro_session');
  window.location.href = 'staff-login.html';
};

// Drop-in replacement for fetch() on any authenticated Supabase call.
// On a 401, refreshes the token once and retries the same request with
// the new token. If the refresh itself fails (refresh token also dead),
// clears the session and redirects to login instead of leaving the page
// stuck on a generic error.
CB.authedFetch = function(url, opts) {
  opts = opts || {};
  if (!opts.headers) opts.headers = CB.authHeaders;
  return fetch(url, opts).then(function(res) {
    if (res.status !== 401) return res;
    return CB.refreshSession().then(function(newToken) {
      var retryOpts = Object.assign({}, opts);
      retryOpts.headers = Object.assign({}, opts.headers, { 'Authorization': 'Bearer ' + newToken });
      return fetch(url, retryOpts);
    }).catch(function() {
      CB.forceReauth();
      return Promise.reject(new Error('SESSION_EXPIRED'));
    });
  });
};

CB.safeJson = function(res) {
  return res.text().then(function(t) {
    var data = null;
    try { data = t ? JSON.parse(t) : null; } catch (e) { data = t; }
    if (!res.ok) {
      var msg = (data && data.message) ? data.message : (typeof data === 'string' ? data : 'Request failed');
      throw new Error(msg);
    }
    return data;
  });
};

// ---------------------------------------------------------------------
// SHARED ROLE-AWARE BOTTOM NAV
// Same tab set/order everywhere: Dashboard, Front Desk, Activity, and
// Patient View (admin only). Built once here so it can't drift page-to-page.
// ---------------------------------------------------------------------
var NAV_ICONS = {
  dashboard: "<rect x='3' y='3' width='7' height='7' rx='1'/><rect x='14' y='3' width='7' height='7' rx='1'/><rect x='3' y='14' width='7' height='7' rx='1'/><rect x='14' y='14' width='7' height='7' rx='1'/>",
  frontdesk: "<path d='M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'/><path d='M9 22V12h6v10'/>",
  activity: "<path d='M3 3v18h18'/><path d='M18 17V9'/><path d='M13 17V5'/><path d='M8 17v-3'/>",
  patientview: "<path d='M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H4a1 1 0 01-1-1V9.5z'/><path d='M9 21V12h6v9'/>"
};

function buildNavItem(key, href, label, active) {
  var a = document.createElement('a');
  a.className = 'nav-item' + (active ? ' active' : '');
  a.href = href;
  a.setAttribute('data-nav-key', key);
  var color = active ? '%230A7EA4' : '%236B7A8D';
  var img = document.createElement('img');
  img.width = 22; img.height = 22;
  img.src = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='22' height='22' fill='none' stroke='" + color + "' stroke-width='2' viewBox='0 0 24 24'>" + NAV_ICONS[key] + "</svg>";
  var span = document.createElement('span');
  span.textContent = label;
  a.appendChild(img);
  a.appendChild(span);
  return a;
}

CB.setNavBadge = function(key, count) {
  var item = document.querySelector('.bottom-nav [data-nav-key="' + key + '"]');
  if (!item) return;
  var existing = item.querySelector('.nav-badge');
  if (count > 0) {
    var text = count > 9 ? '9+' : String(count);
    if (existing) { existing.textContent = text; }
    else {
      var badge = document.createElement('span');
      badge.className = 'nav-badge';
      badge.textContent = text;
      item.appendChild(badge);
    }
  } else if (existing) {
    existing.remove();
  }
};

CB.dashboardUrlForRole = function(role) {
  if (role === 'admin') return 'admin-dashboard.html';
  if (role === 'doctor') return 'doctor-dashboard.html';
  return 'receptionist-dashboard.html';
};

CB.renderBottomNav = function(role, activeKey) {
  var nav = document.getElementById('bottomNav');
  if (!nav) return;
  nav.innerHTML = '';
  nav.appendChild(buildNavItem('dashboard', CB.dashboardUrlForRole(role), 'Dashboard', activeKey === 'dashboard'));
  nav.appendChild(buildNavItem('frontdesk', 'front-desk.html', 'Front Desk', activeKey === 'frontdesk'));
  nav.appendChild(buildNavItem('activity', 'daily-activity.html', 'Activity', activeKey === 'activity'));
  if (role === 'admin') {
    nav.appendChild(buildNavItem('patientview', 'index.html', 'Patient View', activeKey === 'patientview'));
  }
};

CB.showDenied = function(msg, dashboardUrl) {
  var msgEl = document.getElementById('access-denied-msg');
  if (msgEl) msgEl.textContent = msg;
  var link = document.getElementById('access-denied-link');
  if (link && dashboardUrl) {
    link.href = dashboardUrl;
    link.style.display = 'inline-block';
  }
  var denied = document.getElementById('access-denied');
  if (denied) denied.style.display = 'flex';
};

// ---------------------------------------------------------------------
// SHARED BADGE COUNTS (used by whichever page ISN'T the one that already
// has that data loaded, to populate the nav badge on the other tab)
// ---------------------------------------------------------------------
CB.fetchFrontDeskBadgeCount = function(orgId) {
  return CB.authedFetch(CB.SUPABASE_URL + '/rest/v1/whatsapp_conversations?org_id=eq.' + orgId + '&escalation_summary=not.is.null&select=patient_phone', {
    headers: Object.assign({}, CB.authHeaders, { 'Prefer': 'count=exact' })
  }).then(function(res) {
    var range = res.headers.get('content-range');
    if (!range) return 0;
    var total = parseInt(range.split('/')[1], 10);
    return isNaN(total) ? 0 : total;
  }).catch(function() { return 0; });
};

CB.fetchActivityBadgeCount = function(orgId, dateStr) {
  return CB.authedFetch(CB.SUPABASE_URL + '/rest/v1/rpc/get_daily_activity', {
    method: 'POST', headers: CB.authHeaders, body: JSON.stringify({ p_org_id: orgId, p_date: dateStr })
  }).then(CB.safeJson).then(function(rows) {
    return (rows || []).filter(function(r) { return r.needs_followup; }).length;
  }).catch(function() { return 0; });
};
