import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../src/App';
import { createProject } from '../src/domain/project';
import { createSampleProject } from '../src/domain/sample';
import { ProjectRepository } from '../src/persistence/projectRepository';
import { StoreProvider } from '../src/state/StoreProvider';
import { ProjectStore } from '../src/state/store';
import { MemoryStorage } from './helpers';

afterEach(() => {
  cleanup();
  window.location.hash = '#/';
});

function renderApp(storage: MemoryStorage, hash: string) {
  window.location.hash = hash;
  const repository = new ProjectRepository(storage);
  const store = new ProjectStore(repository, { autosave: false });
  render(
    <StoreProvider store={store}>
      <App store={store} />
    </StoreProvider>,
  );
  return { repository, store };
}

function seedProject(storage: MemoryStorage, title: string): string {
  const repository = new ProjectRepository(storage);
  const created = repository.create(
    createProject({
      title,
      mode: 'factual',
      targetDuration: 60,
      visualPreset: 'clean-educational',
    }),
  );
  if (!created.ok) throw new Error(created.message);
  return created.project.id;
}

function seedSample(storage: MemoryStorage): string {
  const repository = new ProjectRepository(storage);
  const created = repository.create(createSampleProject());
  if (!created.ok) throw new Error(created.message);
  return created.project.id;
}

describe('project deletion', () => {
  it('requires confirmation before removing a project', async () => {
    const storage = new MemoryStorage();
    const id = seedProject(storage, 'Delete me carefully');
    const { repository } = renderApp(storage, '#/');

    const title = await screen.findByText('Delete me carefully');
    const card = title.closest('li');
    expect(card).not.toBeNull();
    const cardWithin = within(card as HTMLElement);

    fireEvent.click(cardWithin.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(repository.read(id).ok).toBe(true);

    fireEvent.click(cardWithin.getByRole('button', { name: 'Delete' }));
    const confirmDialog = await screen.findByRole('dialog');
    fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Delete project' }));

    expect(repository.read(id).ok).toBe(false);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByText('Delete me carefully')).toBeNull();
  });
});

describe('dialog focus', () => {
  it('traps Tab inside the dialog and restores focus to the trigger when closed', async () => {
    const storage = new MemoryStorage();
    seedProject(storage, 'Focus trap project');
    renderApp(storage, '#/');

    const trigger = await screen.findByRole('button', { name: 'Delete' });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = await screen.findByRole('dialog');
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    const confirm = within(dialog).getByRole('button', { name: 'Delete project' });

    // Focus moves into the dialog when it opens.
    expect(document.activeElement).toBe(cancel);

    // Tab off the last control wraps to the first, Shift+Tab from the first wraps back.
    confirm.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirm);

    fireEvent.click(cancel);
    expect(document.activeElement).toBe(trigger);
  });
});

describe('preview honesty', () => {
  it('labels the preview as a storyboard, not a rendered video, and names missing providers', async () => {
    const storage = new MemoryStorage();
    const id = seedSample(storage);
    renderApp(storage, `#/projects/${id}/preview`);

    expect(
      await screen.findByText('Storyboard preview — not the rendered video.'),
    ).toBeTruthy();
    expect(screen.getByText('AI narration not connected.')).toBeTruthy();
    expect(screen.getByText('AI media generation not connected.')).toBeTruthy();
    expect(
      screen.getByText('MP4 rendering and uploaded audio on the Export screen.'),
    ).toBeTruthy();
    // Placeholder visuals are labeled rather than faked.
    expect(screen.getAllByText(/Placeholder visual — no image attached/).length).toBeGreaterThan(0);
  });
});

describe('export honesty', () => {
  it('offers a silent MP4 render and states the limits honestly', async () => {
    const storage = new MemoryStorage();
    const id = seedSample(storage);
    renderApp(storage, `#/projects/${id}/export`);

    expect(await screen.findByText(/720×1280 · 30 fps target · H\.264 video/)).toBeTruthy();
    expect(screen.getByText(/no audio track/)).toBeTruthy();
    const renderButton = screen.getByRole('button', { name: 'Render silent MP4' });
    expect(renderButton).toHaveProperty('disabled', false);
    // No result is shown before a render actually happens.
    expect(screen.queryByRole('link', { name: 'Download MP4' })).toBeNull();
    expect(screen.getByText(/No rendered video yet/)).toBeTruthy();
    expect(screen.getByText(/Hard cuts only/)).toBeTruthy();
  });

  it('says upload audio binaries are not part of the JSON backup', async () => {
    const storage = new MemoryStorage();
    const id = seedSample(storage);
    renderApp(storage, `#/projects/${id}/export`);

    const notes = await screen.findAllByText(
      /narration audio\s+binaries, music audio binaries/,
    );
    expect(notes).toHaveLength(2);
    expect(notes.some((note) => /not included in this JSON file/i.test(note.textContent ?? ''))).toBe(
      true,
    );
  });

  it('downloads project data as a .json file', async () => {
    const storage = new MemoryStorage();
    const id = seedSample(storage);
    renderApp(storage, `#/projects/${id}/export`);

    const createObjectURL = vi.fn(() => 'blob:project-data');
    Object.defineProperty(URL, 'createObjectURL', {
      value: createObjectURL,
      configurable: true,
      writable: true,
    });
    let clicked: HTMLAnchorElement | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked = this;
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Export project data' }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clicked).not.toBeNull();
    expect((clicked as unknown as HTMLAnchorElement).download).toMatch(/\.json$/);
  });
});
