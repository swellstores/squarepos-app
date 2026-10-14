<!doctype html>
<html>
  <head>
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Square POS needs attention</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1f2933;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:8px;">
            <tr>
              <td style="padding:32px;">
                {% if key == 'connection' %}
                <h1 style="margin:0 0 16px;font-size:20px;line-height:28px;font-weight:600;">Square POS is not syncing with {{ store.name }}</h1>
                <p style="margin:0 0 16px;font-size:15px;line-height:24px;">{{ message }}</p>
                <p style="margin:0 0 16px;font-size:15px;line-height:24px;">Until this is corrected, stock changes are not passed on and sales are not imported. Nothing is lost: once the connection works again, the stock of both sides is compared and the changes of each are passed to the other, and the sales made meanwhile are imported.</p>
                <p style="margin:0 0 8px;font-size:15px;line-height:24px;font-weight:600;">To fix it</p>
                <ol style="margin:0 0 24px;padding-left:20px;font-size:15px;line-height:24px;">
                  <li>In Swell, open Apps → Square POS → Settings.</li>
                  <li>Correct what the message above names: the access token (from your application's Credentials page in the Square Developer Console) or a location name.</li>
                  <li>Save and press Test connection.</li>
                </ol>
                {% elsif key == 'webhook' %}
                <h1 style="margin:0 0 16px;font-size:20px;line-height:28px;font-weight:600;">Square's notices to {{ store.name }} have stopped</h1>
                <p style="margin:0 0 16px;font-size:15px;line-height:24px;">{{ message }}</p>
                <p style="margin:0 0 24px;font-size:15px;line-height:24px;">Open Apps → Square POS → Settings and press Test connection.</p>
                {% elsif key == 'stock' %}
                <h1 style="margin:0 0 16px;font-size:20px;line-height:28px;font-weight:600;">Some items no longer share their stock with Square</h1>
                <p style="margin:0 0 16px;font-size:15px;line-height:24px;">{{ message }}</p>
                <p style="margin:0 0 24px;font-size:15px;line-height:24px;">Each item is listed with what stopped it. After correcting the cause, select the items and choose Start syncing: you say which side has the right quantity, and the other side takes it. All other items keep syncing.</p>
                {% else %}
                <h1 style="margin:0 0 16px;font-size:20px;line-height:28px;font-weight:600;">A Square sale could not be imported</h1>
                <p style="margin:0 0 16px;font-size:15px;line-height:24px;">{{ message }}</p>
                <p style="margin:0 0 24px;font-size:15px;line-height:24px;">It is listed under Orders → Square sales → Needs attention, where you can retry it after correcting the cause, or mark it as resolved after recording the sale by hand. You will not get another e-mail while sales are waiting there. Stock is not affected: the stock sync does not depend on the import.</p>
                {% endif %}
                <p style="margin:0 0 24px;">
                  <a href="{{ store.admin_url }}/admin/apps{% if app_id %}/{{ app_id }}{% if key == 'connection' or key == 'webhook' %}?tab=settings{% endif %}{% endif %}" style="display:inline-block;padding:10px 20px;background-color:#1f2933;color:#ffffff;font-size:15px;line-height:20px;text-decoration:none;border-radius:6px;">Open the Square POS app</a>
                </p>
                <p style="margin:0;font-size:13px;line-height:20px;color:#616e7c;">If the subject of this e-mail starts with (TEST), the problem is in your store's test environment: switch the dashboard to it after opening the app.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
