export type MascotState = 'idle' | 'focused' | 'happy' | 'success' | 'deployment' | 'sleep' | 'sad';

export function getMascotAssetPath(state: MascotState = 'idle'): string {
  // The sad artwork was uploaded with a capitalized filename.
  const assetName = state === 'sad' ? 'Sad.png' : `${state}.png`;
  return `media/mascot/${assetName}`;
}

export function buildMascotSvg(state: MascotState = 'idle', assetUri?: string): string {
  const resolvedAssetUri = assetUri ?? getMascotAssetPath(state);
  // The crouched sad pose has a wider silhouette, so render it slightly smaller
  // to keep its perceived scale aligned with the standing mascot poses.
  const width = state === 'sad' ? 145 : 180;

  return `
    <img
      class="mascot ${state}"
      src="${resolvedAssetUri}"
      alt="Salesforce coding mascot"
      style="display:block; width:${width}px; height:auto; object-fit:contain; background:transparent;"
      onerror="this.onerror=null; this.src='media/mascot/idle.png';"
    />
  `;
}
