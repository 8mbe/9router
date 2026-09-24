"use client";

import PropTypes from "prop-types";
import { COMPATIBLE_MEDIA_KINDS } from "@/shared/utils/compatibleMedia";

const LABELS = {
  image: "Text to Image",
  embedding: "Embedding",
  tts: "Text to Speech",
  stt: "Speech to Text",
};

export default function CompatibleMediaKindsField({ value, onChange }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium mb-1">Media endpoints</legend>
      <p className="text-xs text-text-muted">Enable only the endpoints this provider supports. Models can be added on its media pages.</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {COMPATIBLE_MEDIA_KINDS.map((kind) => (
          <label key={kind} className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={value.includes(kind)}
              onChange={(event) => onChange(event.target.checked
                ? [...value, kind]
                : value.filter((entry) => entry !== kind))}
            />
            {LABELS[kind]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

CompatibleMediaKindsField.propTypes = {
  value: PropTypes.arrayOf(PropTypes.string).isRequired,
  onChange: PropTypes.func.isRequired,
};
