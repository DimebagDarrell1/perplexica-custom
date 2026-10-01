import BaseEmbedding from "../models/base/embedding";
import UploadManager from "./manager";
import computeSimilarity from "../utils/computeSimilarity";
import { Chunk } from "../types";

type UploadStoreParams = {
    embeddingModel: BaseEmbedding<any>;
    fileIds: string[];
}

type StoreRecord = {
    embedding: number[];
    content: string;
    fileId: string;
    metadata: Record<string, any>
}

class UploadStore {
    embeddingModel: BaseEmbedding<any>;
    fileIds: string[];
    records: StoreRecord[] = [];

    constructor(private params: UploadStoreParams) {
        this.embeddingModel = params.embeddingModel;
        this.fileIds = params.fileIds;
        this.initializeStore()
    }

    initializeStore() {
        Array.from(new Set(this.fileIds)).forEach((fileId) => {
            const file = UploadManager.getFile(fileId)

            if (!file) {
                throw new Error(`File with ID ${fileId} not found`);
            }

            const chunks = UploadManager.getFileChunks(fileId);

            this.records.push(...chunks.map((chunk) => ({
                embedding: chunk.embedding,
                content: chunk.content,
                fileId: fileId,
                metadata: {
                    fileName: file.name,
                    title: file.name,
                    url: `file_id://${file.id}`,
                }
            })))
        })
    }

    async query(queries: string[], topK: number): Promise<Chunk[]> {
        const queryEmbeddings = await this.embeddingModel.embedText(queries)

        const results = queryEmbeddings.map((query) => {
            return this.records.map((record, idx) => {
                return {
                    recordIndex: idx,
                    chunk: {
                        content: record.content,
                        metadata: {
                            ...record.metadata,
                            fileId: record.fileId,
                        }
                    },
                    score: computeSimilarity(query, record.embedding)
                } as { recordIndex: number; chunk: Chunk; score: number; };
            }).sort((a, b) => b.score - a.score)
        })

        const chunkMap: Map<number, Chunk> = new Map();
        const scoreMap: Map<number, number> = new Map();
        const k = 60;

        for (let i = 0; i < results.length; i++) {
            for (let j = 0; j < results[i].length; j++) {
                const recordIndex = results[i][j].recordIndex

                chunkMap.set(recordIndex, results[i][j].chunk);
                scoreMap.set(recordIndex, (scoreMap.get(recordIndex) || 0) + 1 / (j + 1 + k));
            }
        }

        const finalResults = Array.from(scoreMap.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([recordIndex, _score]) => {
                return chunkMap.get(recordIndex)!;
            })

        return finalResults.slice(0, topK);
    }

    static getFileData(fileIds: string[]): { fileName: string; initialContent: string }[] {
        const filesData: { fileName: string; initialContent: string }[] = [];

        fileIds.forEach((fileId) => {
            const file = UploadManager.getFile(fileId)

            if (!file) {
                throw new Error(`File with ID ${fileId} not found`);
            }

            const chunks = UploadManager.getFileChunks(fileId);

            filesData.push({
                fileName: file.name,
                initialContent: chunks.slice(0, 3).map(c => c.content).join('\n---\n'),
            })
        })

        return filesData
    }
}

export default UploadStore