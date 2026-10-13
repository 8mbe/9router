"use client";

import { useId } from "react";
import PropTypes from "prop-types";

export default function CustomApiOptions({ value, onChange, disabled = false }) {
  const hintId = useId();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <label className="flex min-h-10 items-center gap-2 text-sm font-medium text-text-main cursor-pointer">
          <input
            type="checkbox"
            checked={value.anonymizeRequests}
            onChange={(event) => onChange({ ...value, anonymizeRequests: event.target.checked })}
            disabled={disabled}
            aria-describedby={`${hintId}-privacy`}
            className="size-4 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          />
          Anonymize requests
        </label>
        <p id={`${hintId}-privacy`} className="text-xs text-text-muted">
          Remove client session, user, device and tracing identifiers, cookies and identifying metadata. The API key, your messages and your IP can still identify you. Resumed upstream conversations stay linked. Use a proxy to hide your IP.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="flex min-h-10 items-center gap-2 text-sm font-medium text-text-main cursor-pointer">
          <input
            type="checkbox"
            checked={value.customApiSessionPinning}
            onChange={(event) => onChange({ ...value, customApiSessionPinning: event.target.checked })}
            disabled={disabled}
            aria-describedby={`${hintId}-pinning ${hintId}-proxy`}
            className="size-4 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          />
          Pin account and proxy session
        </label>
        <p id={`${hintId}-pinning`} className="text-xs text-text-muted">
          Keep using the selected account and its proxy session until the account is unavailable. New requests use another account while active streams finish. Retire the old proxy session after all its requests end.
        </p>
        <p id={`${hintId}-proxy`} className="text-xs text-text-muted break-words">
          Select an active Bright Data proxy pool using <code>brd.superproxy.io</code>, or put <code>{"{session}"}</code> in your proxy username or password. Pinning always uses the proxy, even for No Proxy destinations.
        </p>
      </div>
    </div>
  );
}

CustomApiOptions.propTypes = {
  value: PropTypes.shape({
    anonymizeRequests: PropTypes.bool.isRequired,
    customApiSessionPinning: PropTypes.bool.isRequired,
  }).isRequired,
  onChange: PropTypes.func.isRequired,
  disabled: PropTypes.bool,
};
