import { ClassConstructor, getLogger, getSerializer, Persistence, WorkflowData } from '@node-ts/bus-core'
import { Message, MessageAttributes } from '@node-ts/bus-messages'
import { Pool } from 'pg'
import { PostgresConfiguration } from './postgres-configuration'
import { WorkflowDataNotFound } from './error'
import { MessageWorkflowMapping } from '@node-ts/bus-workflow'

/**
 * The name of the field that stores workflow data as JSON in the database row.
 */
const WORKFLOW_DATA_FIELD_NAME = 'data'

export class PostgresPersistence implements Persistence {

  private constructor (
    private readonly postgres: Pool,
    private readonly configuration: PostgresConfiguration
  ) {
  }

  static configure (configuration: PostgresConfiguration): PostgresPersistence {
    return new PostgresPersistence(
      new Pool(configuration.connection),
      configuration
    )
  }

  async initialize (): Promise<void> {
    getLogger().info('Initializing postgres persistence...')
    await this.ensureSchemaExists(this.configuration.schemaName)
    getLogger().info('Postgres persistence initialized')
  }

  async dispose (): Promise<void> {
    getLogger().info('Disposing postgres persistence...')
    await this.postgres.end()
    getLogger().info('Postgres persistence disposed')
  }

  async initializeWorkflow<WorkflowDataType extends WorkflowData> (
    workflowDataConstructor: ClassConstructor<WorkflowDataType>,
    messageWorkflowMappings: MessageWorkflowMapping<Message, WorkflowData>[]
  ): Promise<void> {
    const workflowDataName = new workflowDataConstructor().$name
    getLogger().info('Initializing workflow', { workflowData: workflowDataName })

    const tableName = resolveQualifiedTableName(workflowDataName, this.configuration.schemaName)
    await this.ensureTableExists(tableName)
    await this.ensureIndexesExist(tableName, messageWorkflowMappings)
  }

  async getWorkflowData<WorkflowDataType extends WorkflowData, MessageType extends Message> (
    workflowDataConstructor: ClassConstructor<WorkflowDataType>,
    messageMap: MessageWorkflowMapping<MessageType, WorkflowDataType>,
    message: MessageType,
    messageOptions: MessageAttributes,
    includeCompleted = false
  ): Promise<WorkflowDataType[]> {
    getLogger().debug('Getting workflow data', { workflowDataName: workflowDataConstructor.name })
    const workflowDataName = new workflowDataConstructor().$name
    const tableName = resolveQualifiedTableName(workflowDataName, this.configuration.schemaName)
    const matcherValue = messageMap.lookupMessage(message, messageOptions)

    const workflowDataField = `${WORKFLOW_DATA_FIELD_NAME}->>'${messageMap.workflowDataProperty}'`
    const query = `
      select
        ${WORKFLOW_DATA_FIELD_NAME}
      from
        ${tableName}
      where
        (${includeCompleted} = true or ${WORKFLOW_DATA_FIELD_NAME}->>'$status' = 'running')
        and (${workflowDataField}) is not null
        and (${workflowDataField}::text) = $1
    `
    getLogger().debug('Querying workflow data', { query })

    const results = await this.postgres.query(
      query,
      [matcherValue]
    )

    getLogger().debug('Got workflow data', { resultsCount: results.rows.length })

    const rows = results.rows as [{ [WORKFLOW_DATA_FIELD_NAME]: WorkflowDataType | undefined }]

    return rows
      .map(row => row[WORKFLOW_DATA_FIELD_NAME])
      .filter(workflowData => workflowData !== undefined)
      .map(workflowData => getSerializer().toClass(workflowData!, workflowDataConstructor))
  }

  async saveWorkflowData<WorkflowDataType extends WorkflowData> (
    workflowData: WorkflowDataType
  ): Promise<void> {
    getLogger().debug('Saving workflow data', { workflowDataName: workflowData.$name, id: workflowData.$workflowId })
    const tableName = resolveQualifiedTableName(workflowData.$name, this.configuration.schemaName)

    const oldVersion = workflowData.$version
    const newVersion = oldVersion + 1
    const plainWorkflowData = {
      ...getSerializer().toPlain(workflowData),
      $version: newVersion
    }

    await this.upsertWorkflowData(
      tableName,
      workflowData.$workflowId,
      plainWorkflowData,
      oldVersion,
      newVersion
    )
  }

  private async ensureSchemaExists (schema: string): Promise<void> {
    const sql = `create schema if not exists ${schema};`
    getLogger().debug('Ensuring workflow schema exists', { sql })
    await this.postgres.query(sql)
  }

  private async ensureTableExists (tableName: string): Promise<void> {
    const sql = `
      create table if not exists ${tableName} (
        id uuid not null primary key,
        version integer not null,
        ${WORKFLOW_DATA_FIELD_NAME} jsonb not null
      );
    `
    getLogger().debug('Ensuring postgres table for workflow data exists', { sql })
    await this.postgres.query(sql)
  }

  private async ensureIndexesExist (
    tableName: string,
    messageWorkflowMappings: MessageWorkflowMapping<Message, WorkflowData>[]
  ): Promise<void> {
    const createPrimaryIndex = this.createPrimaryIndex(tableName)

    const allWorkflowFields = messageWorkflowMappings.map(mapping => mapping.workflowDataProperty)
    const distinctWorkflowFields = new Set(allWorkflowFields)
    const workflowFields: string[] = [...distinctWorkflowFields]

    const createSecondaryIndexes = workflowFields.map(async workflowField => {
      const indexName = resolveIndexName(tableName, workflowField)
      const indexNameWithSchema = `${this.configuration.schemaName}.${indexName}`
      const workflowDataField = `${WORKFLOW_DATA_FIELD_NAME}->>'${workflowField}'`
      // Support Postgres 9.4+
      const createSecondaryIndex = `
        DO
        $$
        BEGIN
          IF to_regclass('${indexNameWithSchema}') IS NULL THEN
            CREATE INDEX
              ${indexName}
            ON
              ${tableName} ((${workflowDataField}))
            WHERE
              (${workflowDataField}) is not null;
          END IF;
        END
        $$;
      `
      getLogger().debug('Ensuring secondary index exists', { createSecondaryIndex })
      await this.postgres.query(createSecondaryIndex)
    })

    await Promise.all([createPrimaryIndex, ...createSecondaryIndexes])
  }

  private async createPrimaryIndex (tableName: string): Promise<void> {
    const primaryIndexName = resolveIndexName(tableName, 'id', 'version')
    const primaryIndexNameWithSchema = `${this.configuration.schemaName}.${primaryIndexName}`
    // Support Postgres 9.4+
    const createPrimaryIndexSql = `
      DO
      $$
      BEGIN
        IF to_regclass('${primaryIndexNameWithSchema}') IS NULL THEN
          CREATE INDEX ${primaryIndexName} ON ${tableName} (id, version);
        END IF;
      END
      $$;
    `
    getLogger().debug('Ensuring primary index exists', { createPrimaryIndexSql })
    await this.postgres.query(createPrimaryIndexSql)
  }

  private async upsertWorkflowData (
    tableName: string,
    workflowId: string,
    plainWorkflowData: object,
    oldVersion: number,
    newVersion: number
  ): Promise<void> {
    if (oldVersion === 0) {
      getLogger().debug('Inserting new workflow data', { tableName, workflowId, oldVersion, newVersion })

      // This is a new workflow, so just insert the data
      await this.postgres.query(`
        insert into ${tableName} (
          id,
          version,
          ${WORKFLOW_DATA_FIELD_NAME}
        ) values (
          $1,
          $2,
          $3
        );`,
        [
          workflowId,
          newVersion,
          getSerializer().serialize(plainWorkflowData)
        ])
    } else {
      getLogger().debug('Updating existing workflow data', { tableName, workflowId, oldVersion, newVersion })

      // This is an exsiting workflow, so update teh data
      const result = await this.postgres.query(`
        update
          ${tableName}
        set
          version = $1,
          ${WORKFLOW_DATA_FIELD_NAME} = $2
        where
          id = $3
          and version = $4;`,
        [
          newVersion,
          getSerializer().serialize(plainWorkflowData),
          workflowId,
          oldVersion
        ]
      )

      if (result.rowCount === 0) {
        throw new WorkflowDataNotFound(workflowId, tableName, oldVersion)
      }
    }
  }
}

/**
 * Returns a legal fully qualified schema + table name
 */
function resolveQualifiedTableName (tableName: string, schemaName: string): string {
  const invalidPostgresCharacters = /[^0-9a-zA-Z_.-]/g
  const normalizedTableName = tableName.replace(invalidPostgresCharacters, '').toLowerCase()
  const formattedTableName = toSnakeCase(normalizedTableName)
  return `"${schemaName}"."${formattedTableName}"`
}

/**
 * Converts pascal to snake case
 * @example MyTableName => my_table_name
 */
function toSnakeCase (value: string): string {
  return value.replace(/([A-Z])/g, c => `_${c.toLowerCase()}`)
}

/**
 * Resolves the name of an index from the fields contained in that index
 */
function resolveIndexName (tableName: string, ...fields: string[]): string {
  const normalizedTableName = tableName.replace(/"/g, '').replace('.', '_')
  return `"${normalizedTableName}_${fields.join('_')}_idx"`
}
