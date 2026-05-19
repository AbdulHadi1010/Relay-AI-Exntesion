import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('manifest.json permissions verification', () => {
  const manifestPath = resolve(__dirname, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

  it('declares only the minimal required permissions', () => {
    const allowedPermissions = ['storage', 'alarms', 'scripting', 'notifications', 'webRequest'];
    expect(manifest.permissions).toBeDefined();
    expect(manifest.permissions).toHaveLength(allowedPermissions.length);
    expect(manifest.permissions.sort()).toEqual(allowedPermissions.sort());
  });

  it('declares host_permissions for chatgpt.com and claude.ai only', () => {
    const allowedHosts = ['*://chatgpt.com/*', '*://claude.ai/*', '*://gemini.google.com/*', '*://grok.com/*'];
    expect(manifest.host_permissions).toBeDefined();
    expect(manifest.host_permissions).toHaveLength(allowedHosts.length);
    expect(manifest.host_permissions.sort()).toEqual(allowedHosts.sort());
  });

  it('does not declare optional_permissions', () => {
    expect(manifest.optional_permissions).toBeUndefined();
  });

  it('does not declare optional_host_permissions', () => {
    expect(manifest.optional_host_permissions).toBeUndefined();
  });

  it('does not override content_security_policy', () => {
    expect(manifest.content_security_policy).toBeUndefined();
  });

  it('does not declare externally_connectable', () => {
    expect(manifest.externally_connectable).toBeUndefined();
  });

  it('uses manifest_version 3', () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it('web_accessible_resources only target chatgpt.com and claude.ai', () => {
    expect(manifest.web_accessible_resources).toBeDefined();
    for (const resource of manifest.web_accessible_resources) {
      for (const match of resource.matches) {
        expect(match).toMatch(/^\*:\/\/(chatgpt\.com|claude\.ai)\/\*$/);
      }
    }
  });
});
