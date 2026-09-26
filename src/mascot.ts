export type MascotState = 'idle' | 'focused' | 'happy' | 'success' | 'deployment' | 'sleep';

export function getMascotAssetPath(state: MascotState = 'idle'): string {
  return `media/mascot/${state}.png`;
}

export function buildMascotSvg(state: MascotState = 'idle', assetUri?: string): string {
  const resolvedAssetUri = assetUri ?? getMascotAssetPath(state);

  return `
    <img
      class="mascot ${state}"
      src="${resolvedAssetUri}"
      alt="Salesforce coding mascot"
      style="display:block; width:180px; height:auto; object-fit:contain; background:transparent;"
      onerror="this.onerror=null; this.src='media/mascot/idle.png';"
    />
  `;
}
