/**
 * 「テーブル編集」「カラム辞書の編集」の保存・終了操作をヘッダへ集約するための橋渡し（zustand）。
 *
 * これらの画面はフォーム状態（draft）を各コンポーネントのローカルに持つため、ヘッダから
 * 保存・終了を操作できるよう、編集画面がマウント中だけ「コントローラ」を登録する。
 * ヘッダはこの controller の有無・dirty/saving で保存アイコンや終了（×）の表示を切り替える。
 * ER図の編集は editStore が別途担うため、ここには登録しない。
 */
import { create } from "zustand";

export interface PageEditController {
  /** 未保存の変更があるか（ヘッダの * 表示・終了時の確認に使う） */
  dirty: boolean;
  /** 保存処理の実行中か */
  saving: boolean;
  /** いま保存できるか（例: カラム編集は全テーブルのロード完了まで false） */
  canSave: boolean;
  /** 保存する（成功後は各画面が閲覧ルートへ戻す） */
  save: () => void;
  /** 編集を終了して閲覧ルートへ戻る（未保存は破棄。確認はヘッダが行う） */
  end: () => void;
}

interface PageEditState {
  controller: PageEditController | null;
  setController: (controller: PageEditController | null) => void;
}

export const usePageEditStore = create<PageEditState>((set) => ({
  controller: null,
  setController: (controller) => set({ controller }),
}));
