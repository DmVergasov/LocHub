import { describe, expect, it } from 'vitest';
import { describeOrigin, originLabel, parseOrigin } from '../src/origin';

describe('parseOrigin (mirror of LocHubBridge::ParseOrigin)', () => {
  it('reads gather source locations and file:line', () => {
    expect(parseOrigin('Source/MyGame/Private/Hud/MyHud.cpp(42)')).toEqual({ kind: 'file', path: 'Source/MyGame/Private/Hud/MyHud.cpp', line: 42 });
    expect(parseOrigin('Source\\MyGame\\Hud.cpp:7')).toEqual({ kind: 'file', path: 'Source/MyGame/Hud.cpp', line: 7 });
    expect(parseOrigin('/Source/MyGame/A.cpp(3)')).toEqual({ kind: 'file', path: 'Source/MyGame/A.cpp', line: 3 });
  });

  it('reads asset object paths as the package', () => {
    expect(parseOrigin('/Game/UI/WBP_Pause.WBP_Pause:WidgetTree.TextBlock_0.Text')).toEqual({ kind: 'asset', path: '/Game/UI/WBP_Pause', line: 0 });
  });

  it('refuses what the editor cannot open', () => {
    expect(parseOrigin('').kind).toBe('unknown');
    expect(parseOrigin('/Script/MyGame.Default__MyHud').kind).toBe('unknown');
  });

  it('labels files with their line', () => {
    expect(originLabel(parseOrigin('Source/A.cpp(9)'))).toBe('Source/A.cpp:9');
    expect(originLabel(parseOrigin('/Game/UI/WBP_Pause.WBP_Pause'))).toBe('/Game/UI/WBP_Pause');
  });
});

describe('describeOrigin', () => {
  it('splits an asset origin into its package path and the rest of the object path', () => {
    expect(describeOrigin('/Game/Blueprints/Data/E_Gait.E_Gait.DisplayNameMap(0 - Value).DisplayNameMap')).toEqual({
      kind: 'asset',
      path: '/Game/Blueprints/Data/E_Gait',
      line: 0,
      member: 'E_Gait.DisplayNameMap(0 - Value).DisplayNameMap',
    });
  });

  it('has no member for an asset origin with no dot after the package path', () => {
    expect(describeOrigin('/Game/UI/WBP_Pause')).toEqual({ kind: 'asset', path: '/Game/UI/WBP_Pause', line: 0, member: '' });
  });

  it('has an empty member when the asset origin ends with a bare dot', () => {
    expect(describeOrigin('/Game/UI/WBP_Pause.').member).toBe('');
  });

  it('has no member for a C++ file origin', () => {
    expect(describeOrigin('Source/MyGame/Private/Hud.cpp(42)')).toEqual({
      kind: 'file',
      path: 'Source/MyGame/Private/Hud.cpp',
      line: 42,
      member: '',
    });
  });

  it('has no member for an empty origin', () => {
    expect(describeOrigin('')).toEqual({ kind: 'unknown', path: '', line: 0, member: '' });
  });
});
